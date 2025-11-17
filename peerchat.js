import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@libp2p/gossipsub';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import * as readline from 'readline';
import fs from 'fs';
import bcrypt from 'bcrypt';

// Pubsub topics
const PRESENCE_TOPIC = 'p2p-presence';
const FRIEND_TOPIC = 'p2p-friends';
const MESSAGE_TOPIC = 'p2p-messages';
const GROUP_TOPIC = 'p2p-group';

const ACCOUNTS_DB_FILE = './accounts.json';
const DATA_DIR = './account_data';
const SALT_ROUNDS = 10;

// User state
let myProfile = null;
let currentAccountId = null;
let myPeerId = null;

// Maps for tracking everything
const friends = new Map();
const friendRequests = new Map();
const sentRequests = new Set();
const offlineMessages = new Map();
const offlineGroupMessages = new Map();
const offlineGroupLeaves = new Map();
const groups = new Map(); 
const onlinePeers = new Map(); 

function loadJSON(file, defaultValue = []) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Failed to load ${file}:`, err.message);
  }
  return defaultValue;
}

function saveJSON(file, data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to save ${file}:`, err.message);
  }
}

function saveMyProfile() {
  const accounts = loadJSON(ACCOUNTS_DB_FILE, []);
  const index = accounts.findIndex(acc => acc.fullname === currentAccountId);
  if (index !== -1) accounts[index] = myProfile;
  else accounts.push(myProfile);
  saveJSON(ACCOUNTS_DB_FILE, accounts);
}

function loadData(fullname, dataType, mapTarget) {
  const entries = loadJSON(`${DATA_DIR}/${fullname}_${dataType}.json`, []);
  entries.forEach(([key, value]) => mapTarget.set(key, value));
  if (entries.length > 0) console.log(`Loaded ${entries.length} ${dataType}`);
}

function saveData(dataType, mapSource) {
  saveJSON(`${DATA_DIR}/${currentAccountId}_${dataType}.json`, Array.from(mapSource.entries()));
}

// Peer/friend stuff

function findFullnameByDisplayName(displayName, searchMap) {
  for (const [fullname, data] of searchMap.entries()) {
    if (data.displayName.toLowerCase() === displayName.toLowerCase()) {
      return fullname;
    }
  }
  return null;
}

function findPeerIdByDisplayName(displayName) {
  for (const [peerId, peerInfo] of onlinePeers.entries()) {
    if (peerInfo.displayName.toLowerCase() === displayName.toLowerCase()) {
      return peerId;
    }
  }
  return null;
}

function isFriendOnline(fullname) {
  return [...onlinePeers.values()].some(peer => peer.fullname === fullname);
}

// A user accounces their precesnce
function announcePresence(node) {
  node.services.pubsub.publish(PRESENCE_TOPIC, new TextEncoder().encode(JSON.stringify({
    type: 'PRESENCE',
    peerId: myPeerId,
    displayName: myProfile.displayName,
    fullname: myProfile.fullname
  }))).catch(err => console.error('Failed to announce presence:', err.message));
}

// Broadcast users online/offline precense
function handlePresence(peerId, displayName, fullname, node) {
  if (peerId !== myPeerId && !onlinePeers.has(peerId)) {
    onlinePeers.set(peerId, { displayName, fullname });
    if (friends.has(fullname)) {
      console.log(`\nFriend ${displayName} is online`);
      process.stdout.write('> ');
      
      // Send queued offline messages
      if (offlineMessages.has(fullname)) {
        const messages = offlineMessages.get(fullname);
        messages.forEach(msg => {
          publishMessage(MESSAGE_TOPIC, {
            type: 'DIRECT_MESSAGE',
            from: myPeerId,
            fromName: myProfile.displayName,
            fromFullname: myProfile.fullname,
            toFullname: fullname,
            to: peerId,
            message: msg.message,
            timestamp: msg.timestamp
          }, node);
        });
        console.log(`Delivered ${messages.length} queued direct message to ${displayName}`);
        process.stdout.write('> ');
        offlineMessages.delete(fullname);
        saveData('messages', offlineMessages);
      }
      
      // Queue group msgs
      if (offlineGroupMessages.has(fullname)) {
        const groupMsgs = offlineGroupMessages.get(fullname);
        groupMsgs.forEach(msg => {
          publishMessage(GROUP_TOPIC, {
            type: 'GROUP_MESSAGE',
            groupId: msg.groupId,
            groupName: msg.groupName,
            from: peerId,
            fromName: msg.fromName,
            fromFullname: msg.fromFullname,
            message: msg.message,
            timestamp: msg.timestamp
          }, node);
        });
        console.log(`Delivered ${groupMsgs.length} queued group message(s) to ${displayName}`);
        process.stdout.write('> ');
        offlineGroupMessages.delete(fullname);
        saveData('groupmessages', offlineGroupMessages);
      }
      
      // deliver queued group leave events
      if (offlineGroupLeaves.has(fullname)) {
        const leaveEvents = offlineGroupLeaves.get(fullname);
        leaveEvents.forEach(event => {
          publishMessage(GROUP_TOPIC, {
            type: 'GROUP_LEAVE',
            groupId: event.groupId,
            groupName: event.groupName,
            peerId: event.peerId,
            peerName: event.peerName,
            peerFullname: event.peerFullname
          }, node);
        });
        console.log(`Delivered ${leaveEvents.length} queued group leave event(s) to ${displayName}`);
        process.stdout.write('> ');
        offlineGroupLeaves.delete(fullname);
        saveData('groupleaves', offlineGroupLeaves);
      }
    }
  }
}

function publishMessage(topic, data, node) {
  node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(data)))
    .catch(err => console.error(`Failed to publish to ${topic}:`, err.message));
}

// A user sends a friend request
function sendFriendRequest(toPeerId, node) {
  const peerInfo = onlinePeers.get(toPeerId);
  if (!peerInfo) return { success: false, message: 'Peer not found or offline' };
  if (friends.has(peerInfo.fullname)) return { success: false, message: 'Already friends with this peer' };
  if (sentRequests.has(peerInfo.fullname)) return { success: false, message: 'Friend request already sent' };

  sentRequests.add(peerInfo.fullname);
  publishMessage(FRIEND_TOPIC, {
    type: 'FRIEND_REQUEST',
    from: myPeerId,
    fromName: myProfile.displayName,
    fromFullname: myProfile.fullname,
    to: toPeerId
  }, node);
  return { success: true, message: `Friend request sent to ${peerInfo.displayName}` };
}

// Broadcast user getting a friend request
function handleFriendRequest(fromName, fromFullname) {
  if (!friends.has(fromFullname) && !friendRequests.has(fromFullname)) {
    friendRequests.set(fromFullname, { displayName: fromName, timestamp: new Date().toISOString() });
    console.log(`\nFriend request from ${fromName}! Use /requests to view.`);
    process.stdout.write('> ');
  }
}

// A user accepts a friend request
function acceptFriendRequest(fromFullname, node) {
  if (!friendRequests.has(fromFullname)) return { success: false, message: 'No pending request from this peer' };

  const friendData = friendRequests.get(fromFullname);
  friends.set(fromFullname, { displayName: friendData.displayName, addedAt: new Date().toISOString() });
  friendRequests.delete(fromFullname);
  sentRequests.delete(fromFullname);
  saveData('friends', friends);

  const toPeerId = [...onlinePeers.entries()].find(([peerId, info]) => info.fullname === fromFullname)?.[0];
  if (toPeerId) {
    publishMessage(FRIEND_TOPIC, {
      type: 'FRIEND_ACCEPT',
      from: myPeerId,
      fromName: myProfile.displayName,
      fromFullname: myProfile.fullname,
      to: toPeerId
    }, node);
  }
  return { success: true, message: `You are now friends with ${friendData.displayName}` };
}

// Broadcast user accpeting a firend request
function handleFriendAccept(fromName, fromFullname) {
  if (!friends.has(fromFullname)) {
    friends.set(fromFullname, { displayName: fromName, addedAt: new Date().toISOString() });
    sentRequests.delete(fromFullname);
    saveData('friends', friends);
    console.log(`\n${fromName} accepted your friend request!`);
    process.stdout.write('> ');
  }
}

function rejectFriendRequest(fromFullname) {
  if (!friendRequests.has(fromFullname)) return { success: false, message: 'No pending request from this peer' };
  const friendData = friendRequests.get(fromFullname);
  friendRequests.delete(fromFullname);
  return { success: true, message: `Rejected friend request from ${friendData.displayName}` };
}

// messaging functions

// A user sends a message
function sendMessage(toFullname, message, node) {
  if (!friends.has(toFullname)) return { success: false, message: 'You can only message friends' };

  const friendData = friends.get(toFullname);
  const toPeerEntry = [...onlinePeers.entries()].find(([peerId, info]) => info.fullname === toFullname);
  const isOnline = !!toPeerEntry;

  publishMessage(MESSAGE_TOPIC, {
    type: 'DIRECT_MESSAGE',
    from: myPeerId,
    fromName: myProfile.displayName,
    fromFullname: myProfile.fullname,
    toFullname,
    to: toPeerEntry?.[0] || '',
    message,
    timestamp: new Date().toISOString()
  }, node);

  if (isOnline) return { success: true, message: `Message sent to ${friendData.displayName}` };
  
  if (!offlineMessages.has(toFullname)) offlineMessages.set(toFullname, []);
  offlineMessages.get(toFullname).push({
    from: myProfile.fullname,
    fromName: myProfile.displayName,
    message,
    timestamp: new Date().toISOString()
  });
  saveData('messages', offlineMessages);
  return { success: true, message: `Message queued for ${friendData.displayName} (offline)` };
}

// Broadcast message handling
function handleDirectMessage(fromName, fromFullname, message, timestamp) {
  if (friends.has(fromFullname)) {
    console.log(`\n[${fromName}] (${new Date(timestamp).toLocaleString()}): ${message}`);
    process.stdout.write('> ');
  }
}

// Send queued offline messages
function deliverOfflineMessages(myFullname) {
  const messages = offlineMessages.get(myFullname);
  if (messages?.length > 0) {
    console.log(`\nYou have ${messages.length} offline message(s):\n`);
    messages.forEach(msg => {
      console.log(`  [${msg.fromName}] (${new Date(msg.timestamp).toLocaleString()}): ${msg.message}`);
    });
    console.log('');
    offlineMessages.delete(myFullname);
    saveData('messages', offlineMessages);
  }
}

// Send queued online messages
function deliverOfflineGroupMessages() {
  const messages = offlineGroupMessages.get(myProfile.fullname);
  if (messages?.length > 0) {
    console.log(`\nYou have ${messages.length} offline group message(s):\n`);
    messages.forEach(msg => {
      console.log(`  [${msg.groupName}] ${msg.fromName} (${new Date(msg.timestamp).toLocaleString()}): ${msg.message}`);
    });
    console.log('');
    offlineGroupMessages.delete(myProfile.fullname);
    saveData('groupmessages', offlineGroupMessages);
  }
}

// Broadcast that a group participant left to other group participants who were offline
function deliverOfflineGroupLeaves() {
  const leaveEvents = offlineGroupLeaves.get(myProfile.fullname);
  if (leaveEvents?.length > 0) {
    console.log(`\nProcessing ${leaveEvents.length} group leave event(s)...\n`);
    leaveEvents.forEach(event => {
      const group = groups.get(event.groupId);
      if (group) {
        group.participants = group.participants.filter(p => p.fullname !== event.peerFullname);
        
        // cleanup empty ones
        if (group.participants.length === 0 && group.invitations.length === 0) {
          groups.delete(event.groupId);
        }
        
        // Show notification if we're still in it
        if (group.participants.some(p => p.fullname === myProfile.fullname)) {
          console.log(`  ${event.peerName} left "${event.groupName}"`);
        }
      }
    });
    console.log('');
    offlineGroupLeaves.delete(myProfile.fullname);
    saveData('groups', groups);
    saveData('groupleaves', offlineGroupLeaves);
  }
}

// group stuff

function findGroupByName(groupName) {
  for (const [groupId, group] of groups.entries()) {
    if (group.name.toLowerCase() === groupName.toLowerCase() && 
        (group.participants.some(p => p.fullname === myProfile.fullname) || 
         group.invitations.some(i => i.fullname === myProfile.fullname))) {
      return { groupId, group };
    }
  }
  return null;
}

function createGroup(groupName) {
  // Prevent creating group with same name
  for (const [groupId, group] of groups.entries()) {
    if (group.name.toLowerCase() === groupName.toLowerCase() && 
        (group.participants.some(p => p.fullname === myProfile.fullname))) {
      return { success: false, message: `You already have a group named "${groupName}"` };
    }
  }
  
  const groupId = `${myProfile.fullname}_${groupName.toLowerCase()}`;
  groups.set(groupId, {
    name: groupName,
    creatorName: myProfile.displayName,
    creatorFullname: myProfile.fullname,
    participants: [{ name: myProfile.displayName, fullname: myProfile.fullname }],
    invitations: []
  });
  saveData('groups', groups);
  return { success: true, message: `Group "${groupName}" created!` };
}

function inviteToGroup(groupName, displayName, node) {
  const found = findGroupByName(groupName);
  if (!found) return { success: false, message: `Group "${groupName}" not found` };
  
  const { groupId, group } = found;
  if (!group.participants.some(p => p.fullname === myProfile.fullname))
    return { success: false, message: 'You are not a participant of this group' };
  
  const toPeerId = findPeerIdByDisplayName(displayName);
  if (!toPeerId) return { success: false, message: `Peer "${displayName}" not found or offline` };
  
  const peerInfo = onlinePeers.get(toPeerId);
  if (!friends.has(peerInfo.fullname)) return { success: false, message: 'You can only invite friends' };
  if (group.participants.some(p => p.fullname === peerInfo.fullname)) return { success: false, message: 'User is already a participant' };
  if (group.invitations.some(i => i.fullname === peerInfo.fullname)) return { success: false, message: 'User already has a pending invitation' };

  group.invitations.push({ name: peerInfo.displayName, fullname: peerInfo.fullname });
  saveData('groups', groups);

  publishMessage(GROUP_TOPIC, {
    type: 'GROUP_INVITE',
    groupId,
    groupName: group.name,
    from: myPeerId,
    fromName: myProfile.displayName,
    fromFullname: myProfile.fullname,
    to: toPeerId,
    toName: peerInfo.displayName,
    toFullname: peerInfo.fullname
  }, node);
  
  return { success: true, message: `Invitation sent to ${peerInfo.displayName}` };
}

function handleGroupInvite(groupId, groupName, fromName, fromFullname, toFullname) {
  if (toFullname !== myProfile.fullname) return;

  let group = groups.get(groupId);
  if (!group) {
    group = {
      name: groupName,
      creatorName: fromName,
      creatorFullname: fromFullname,
      participants: [{ name: fromName, fullname: fromFullname }],
      invitations: [{ name: myProfile.displayName, fullname: myProfile.fullname }]
    };
    groups.set(groupId, group);
  } else if (!group.invitations.some(i => i.fullname === myProfile.fullname)) {
    group.invitations.push({ name: myProfile.displayName, fullname: myProfile.fullname });
  }
  
  saveData('groups', groups);
  console.log(`\nGroup invitation from ${fromName} to join "${groupName}"! Use /groupinvites to view`);
  process.stdout.write('> ');
}

function acceptGroupInvite(groupName, node) {
  const found = findGroupByName(groupName);
  if (!found) return { success: false, message: `Group "${groupName}" not found` };
  
  const { groupId, group } = found;
  if (!group.invitations.find(i => i.fullname === myProfile.fullname)) 
    return { success: false, message: 'No invitation found' };

  group.invitations = group.invitations.filter(i => i.fullname !== myProfile.fullname);
  group.participants.push({ name: myProfile.displayName, fullname: myProfile.fullname });
  saveData('groups', groups);

  publishMessage(GROUP_TOPIC, {
    type: 'GROUP_JOIN',
    groupId,
    groupName: group.name,
    peerId: myPeerId,
    peerName: myProfile.displayName,
    peerFullname: myProfile.fullname
  }, node);
  
  return { success: true, message: `Joined group "${group.name}"` };
}

function handleGroupJoin(groupId, peerName, peerFullname) {
  const group = groups.get(groupId);
  if (group && !group.participants.some(p => p.fullname === peerFullname)) {
    group.participants.push({ name: peerName, fullname: peerFullname });
    saveData('groups', groups);
    if (group.participants.some(p => p.fullname === myProfile.fullname)) {
      console.log(`\n${peerName} joined "${group.name}"`);
      process.stdout.write('> ');
    }
  }
}

function rejectGroupInvite(groupName) {
  const found = findGroupByName(groupName);
  if (!found) return { success: false, message: `Group "${groupName}" not found` };
  
  const { groupId, group } = found;
  group.invitations = group.invitations.filter(i => i.fullname !== myProfile.fullname);
  if (group.participants.length === 0 && group.invitations.length === 0) groups.delete(groupId);
  else saveData('groups', groups);
  
  return { success: true, message: 'Invitation rejected' };
}

// User leaves a group
function leaveGroup(groupName, node) {
  const found = findGroupByName(groupName);
  if (!found) return { success: false, message: `Group "${groupName}" not found` };
  
  const { groupId, group } = found;
  if (!group.participants.some(p => p.fullname === myProfile.fullname))
    return { success: false, message: 'You are not in this group'};

  group.participants = group.participants.filter(p => p.fullname !== myProfile.fullname);
  
  const leaveData = {
    type: 'GROUP_LEAVE',
    groupId,
    groupName: group.name,
    peerId: myPeerId,
    peerName: myProfile.displayName,
    peerFullname: myProfile.fullname
  };
  
  // Broadcast to online participants
  publishMessage(GROUP_TOPIC, leaveData, node);
  
  // Queue leave events for offline participants
  group.participants.forEach(participant => {
    const isOnline = [...onlinePeers.values()].some(peer => peer.fullname === participant.fullname);
    
    if (!isOnline && participant.fullname) {
      if (!offlineGroupLeaves.has(participant.fullname)) {
        offlineGroupLeaves.set(participant.fullname, []);
      }
      offlineGroupLeaves.get(participant.fullname).push({
        groupId,
        groupName: group.name,
        peerId: myPeerId,
        peerName: myProfile.displayName,
        peerFullname: myProfile.fullname
      });
    }
  });
  
  saveData('groupleaves', offlineGroupLeaves);

  if (group.participants.length === 0) groups.delete(groupId);
  else saveData('groups', groups);
  
  return { success: true, message: `Left group "${group.name}"` };
}

// Broadcast to other peers that a user has left a group
function handleGroupLeave(groupId, peerName, peerFullname) {
  const group = groups.get(groupId);
  if (group) {
    group.participants = group.participants.filter(p => p.fullname !== peerFullname);
    
    // cleanup empty ones
    if (group.participants.length === 0 && group.invitations.length === 0) {
      groups.delete(groupId);
    }
    
    saveData('groups', groups);
    
    // only show notification if we're still in it
    if (group.participants.some(p => p.fullname === myProfile.fullname)) {
      console.log(`\n${peerName} left "${group.name}"`);
      process.stdout.write('> ');
    }
  }
}

function sendGroupMessage(groupName, message, node) {
  const found = findGroupByName(groupName);
  if (!found) return { success: false, message: `Group "${groupName}" not found` };
  
  const { groupId, group } = found;
  if (!group.participants.some(p => p.fullname === myProfile.fullname))
    return { success: false, message: 'You are not a participant of this group' };

  const msgData = {
    type: 'GROUP_MESSAGE',
    groupId,
    groupName: group.name,
    from: myPeerId,
    fromName: myProfile.displayName,
    fromFullname: myProfile.fullname,
    message,
    timestamp: new Date().toISOString()
  };

  // Send to all online participants
  publishMessage(GROUP_TOPIC, msgData, node);
  
  // queue messages for offline people
  group.participants.forEach(participant => {
    if (participant.fullname === myProfile.fullname) return; // skip ourselves
    
    const isOnline = [...onlinePeers.values()].some(peer => peer.fullname === participant.fullname);
    
    // queue it if they're offline
    if (!isOnline && participant.fullname) {
      if (!offlineGroupMessages.has(participant.fullname)) {
        offlineGroupMessages.set(participant.fullname, []);
      }
      offlineGroupMessages.get(participant.fullname).push({
        groupId,
        groupName: group.name,
        fromFullname: myProfile.fullname,
        fromName: myProfile.displayName,
        message,
        timestamp: msgData.timestamp
      });
    }
  });
  
  saveData('groupmessages', offlineGroupMessages);
  return { success: true, message: `Message sent to "${group.name}"` };
}

function handleGroupMessage(groupId, fromName, message, fromFullname) {
  const group = groups.get(groupId);
  if (group?.participants.some(p => p.fullname === myProfile.fullname) && fromFullname !== myProfile.fullname) {
    console.log(`\n[${group.name}] ${fromName}: ${message}`);
    process.stdout.write('> ');
  }
}

// setup libp2p node

async function createNode() {
  const node = await createLibp2p({
    addresses: {
      listen: ['/ip4/127.0.0.1/tcp/0']
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      minConnections: 0,
      maxConnections: 50,
      autoDial: false
    },
    services: {
      identify: identify(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: false,
        gossipIncoming: true,
        fallbackToFloodsub: true
      })
    }
  });

  return node;
}

// Account registration/login

async function registerAccount(rl) {
  console.log('\n=== Register New Account ===');
  
  const fullname = await new Promise(resolve => rl.question('Enter your full name: ', resolve));
  if (!fullname || fullname.trim().length === 0) {
    console.log('Full name cannot be empty. Please try again\n');
    return registerAccount(rl);
  }
  
  const password = await new Promise(resolve => rl.question('Create a password: ', resolve));
  if (!password) {
    console.log('Password cannot be empty. Please try again\n');
    return registerAccount(rl);
  }
  
  const displayName = await new Promise(resolve => rl.question('Enter your display name (don\'t use spaces): ', resolve));
  if (!displayName || displayName.trim().length === 0) {
    console.log('Display name cannot be empty. Please try again\n');
    return registerAccount(rl);
  }
  
  try {
    const hash = await new Promise((resolve, reject) => {
      bcrypt.hash(password, SALT_ROUNDS, (err, hash) => {
        if (err) reject(err);
        else resolve(hash);
      });
    });
    
    return {
      fullname: fullname.trim(),
      passwordHash: hash,
      displayName: displayName.trim()
    };
  } catch (err) {
    console.log('Error hashing password. Please try again\n');
    return registerAccount(rl);
  }
}

async function loginAccount(rl, fullname) {
  const password = await new Promise(resolve => rl.question('Password: ', resolve));
  if (!password) {
    console.log('Password cannot be empty\n');
    return null;
  }
  
  const account = loadJSON(ACCOUNTS_DB_FILE, []).find(acc => acc.fullname === fullname);
  if (!account) {
    console.log('Account not found\n');
    return null;
  }
  
  const match = await new Promise(resolve => {
    bcrypt.compare(password, account.passwordHash, (_, result) => resolve(result));
  });
  
  if (!match) {
    console.log('Incorrect password\n');
    return null;
  }
  
  console.log('Login successful\n');
  return account;
}

async function selectOrCreateAccount(rl) {
  const accounts = loadJSON(ACCOUNTS_DB_FILE, []);
  
  if (accounts.length === 0) {
    console.log('\nNo accounts found. Create an accout to get started\n');
    return { action: 'register' };
  }
  
  console.log('\n=== Account Selection ===');
  console.log('Select Account:');
  accounts.forEach((acc, index) => {
    console.log(`  ${index + 1}. ${acc.fullname} (${acc.displayName})`);
  });
  console.log(`  ${accounts.length + 1}. Create new account`);
  
  return new Promise((resolve) => {
    rl.question('\nSelect an account number: ', (answer) => {
      const choice = parseInt(answer);
      
      if (isNaN(choice) || choice < 1 || choice > accounts.length + 1) {
        console.log('Invalid choice. Please try again\n');
        resolve(selectOrCreateAccount(rl));
        return;
      }
      
      if (choice === accounts.length + 1) {
        resolve({ action: 'register' });
      } else {
        resolve({ action: 'login', fullname: accounts[choice - 1].fullname });
      }
    });
  });
}

// Main Function

async function main() {
  console.log('WELCOME TO PEER THING RAHHHHH\n');

  // Make dat friggin node
  const node = await createNode();
  await node.start();

  myPeerId = node.peerId.toString();

  console.log('Node started');
  console.log('Peer ID:', myPeerId);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Account selection/creation flow
  while (true) {
    const choice = await selectOrCreateAccount(rl);
    
    if (choice.action === 'register') {
      const accountData = await registerAccount(rl);
      myProfile = { ...accountData };
      currentAccountId = accountData.fullname;
      saveMyProfile();
      console.log('Account created successfully\n');
      break;
    }
    
    console.log(`\n=== Login as ${choice.fullname} ===`);
    const loginResult = await loginAccount(rl, choice.fullname);
    
    if (loginResult) {
      myProfile = { ...loginResult };
      currentAccountId = choice.fullname;
      saveMyProfile();
      break;
    }
    
    const retry = await new Promise(resolve =>
      rl.question('Try again? (yes/no): ', answer =>
        resolve(['yes', 'y'].includes(answer.toLowerCase().trim()))
      )
    );
    
    if (!retry) {
      console.log('Quitting');
      rl.close();
      await node.stop();
      process.exit(0);
    }
  }

  // Load user data
  loadData(currentAccountId, 'friends', friends);
  loadData(currentAccountId, 'messages', offlineMessages);
  loadData(currentAccountId, 'groupmessages', offlineGroupMessages);
  loadData(currentAccountId, 'groupleaves', offlineGroupLeaves);
  loadData(currentAccountId, 'groups', groups);

  console.log(`\nWelcome, ${myProfile.displayName}!\n`);
  console.log('Conf-chat P2P Network\n');

  // Node address to use for connecting
  const addrs = node.getMultiaddrs();
  if (addrs.length > 0) {
    console.log('Your node address, share this to connect to peers:');
    addrs.forEach(addr => {
      console.log(`   ${addr.toString()}`);
    });
    console.log('');
  }

  console.log('Type /help for available commands\n');

  // Subscribe to everything
  node.services.pubsub.subscribe(PRESENCE_TOPIC);
  node.services.pubsub.subscribe(FRIEND_TOPIC);
  node.services.pubsub.subscribe(MESSAGE_TOPIC);
  node.services.pubsub.subscribe(GROUP_TOPIC);

  // Check for offline messages
  deliverOfflineMessages(myProfile.fullname);
  deliverOfflineGroupMessages();
  deliverOfflineGroupLeaves();

  announcePresence(node);

  // Handle peer connections, event listeners are very intuitive for this
  node.addEventListener('peer:connect', (evt) => {
    console.log('\nPeer connected');
    process.stdout.write('> ');
    setTimeout(() => announcePresence(node), 500);
  });

  node.addEventListener('peer:disconnect', (evt) => {
    const peerInfo = onlinePeers.get(evt.detail.toString());
    if (peerInfo) {
      onlinePeers.delete(evt.detail.toString());
      if (friends.has(peerInfo.fullname)) {
        console.log(`\nFriend ${peerInfo.displayName} is offline`);
        process.stdout.write('> ');
      }
    }
  });

  // Announce presence periodically, like a heartbeat to the other nodes
  setInterval(() => {
    const peers = node.getPeers();
    if (peers.length > 0) {
      announcePresence(node);
    }
  }, 30000);

  // Pubsub message handler
  node.services.pubsub.addEventListener('message', (evt) => {
    try {
      const message = JSON.parse(new TextDecoder().decode(evt.detail.data));
      
      if (evt.detail.topic === PRESENCE_TOPIC) {
        if (message.type === 'PRESENCE') {
          handlePresence(message.peerId, message.displayName, message.fullname, node);
        }
      } else if (evt.detail.topic === FRIEND_TOPIC) {
        if (message.type === 'FRIEND_REQUEST' && message.to === myPeerId) {
          handleFriendRequest(message.fromName, message.fromFullname);
        } else if (message.type === 'FRIEND_ACCEPT' && message.to === myPeerId) {
          handleFriendAccept(message.fromName, message.fromFullname);
        }
      } else if (evt.detail.topic === MESSAGE_TOPIC) {
        if (message.type === 'DIRECT_MESSAGE' && message.toFullname === myProfile.fullname) {
          handleDirectMessage(message.fromName, message.fromFullname, message.message, message.timestamp);
        }
      } else if (evt.detail.topic === GROUP_TOPIC) {
        if (message.type === 'GROUP_INVITE') {
          handleGroupInvite(message.groupId, message.groupName, message.fromName, message.fromFullname, message.toFullname);
        } else if (message.type === 'GROUP_JOIN') {
          handleGroupJoin(message.groupId, message.peerName, message.peerFullname);
        } else if (message.type === 'GROUP_LEAVE') {
          handleGroupLeave(message.groupId, message.peerName, message.peerFullname);
        } else if (message.type === 'GROUP_MESSAGE') {
          handleGroupMessage(message.groupId, message.fromName, message.message, message.fromFullname);
        }
      }
    } catch (err) {
      // ignore bad messages
    }
  });

  // command line interface
  rl.setPrompt('> ');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (input === '/help') {
      console.log('Available commands:');
      console.log('  /connect <multiaddr> - Connect to another local node');
      console.log('  /peers - List connected peers');
      console.log('  /addfriend <display name> - Send friend request');
      console.log('  /requests - View pending friend requests');
      console.log('  /accept <display name> - Accept friend request');
      console.log('  /reject <display name> - Reject friend request');
      console.log('  /friends - List your friends');
      console.log('  /msg <display name> <message> - Send private message');
      console.log('  /creategroup <name> - Create a group');
      console.log('  /invitegroup <group name> <display name> - Invite friend to group');
      console.log('  /groupinvites - View group invitations');
      console.log('  /joingroup <group name> - Join a group');
      console.log('  /rejectgroup <group name> - Reject group invitation');
      console.log('  /groups - List your groups');
      console.log('  /groupmsg <group name> <message> - Send group message');
      console.log('  /leavegroup <group name> - Leave a group');
      console.log('  /quit - Exit');
    } else if (input.startsWith('/connect ')) {
      const multiaddrStr = input.slice(9).trim();
      if (!multiaddrStr) {
        console.log('Usage: /connect <multiaddr>');
        console.log('Example: /connect /ip4/127.0.0.1/tcp/12345/p2p/QmPeerId...');
      } else {
        try {
          const ma = multiaddr(multiaddrStr);
          await node.dial(ma);
          console.log('Connection initiated');
        } catch (err) {
          console.log(`Failed to connect: ${err.message}`);
        }
      }
    } else if (input === '/peers') {
      const peers = node.getPeers();
      if (peers.length === 0) {
        console.log('No connected peers');
      } else {
        console.log(`Connected peers (${peers.length}):`);
        peers.forEach((peer) => {
          const peerStr = peer.toString();
          console.log(`  ${peerStr.slice(0, 16)}...`);
        });
      }
    } else if (input.startsWith('/addfriend ')) {
      const displayName = input.slice(11).trim();
      if (!displayName) {
        console.log('Usage: /addfriend <display name>');
      } else {
        const targetPeerId = findPeerIdByDisplayName(displayName);
        if (targetPeerId) {
          const result = sendFriendRequest(targetPeerId, node);
          console.log(result.message);
        } else {
          console.log(`Peer "${displayName}" not found. Use /peers to see available peers`);
        }
      }
    } else if (input === '/requests') {
      if (friendRequests.size === 0) {
        console.log('No pending friend requests');
      } else {
        console.log('Pending friend requests:');
        for (const [fullname, data] of friendRequests.entries()) {
          console.log(`  ${data.displayName} (${fullname})`);
        }
      }
    } else if (input.startsWith('/accept ')) {
      const displayName = input.slice(8).trim();
      if (!displayName) {
        console.log('Usage: /accept <display name>');
      } else {
        const foundFullname = findFullnameByDisplayName(displayName, friendRequests);
        if (!foundFullname) {
          console.log(`No friend request found from "${displayName}"`);
        } else {
          const result = acceptFriendRequest(foundFullname, node);
          console.log(result.message);
        }
      }
    } else if (input.startsWith('/reject ')) {
      const displayName = input.slice(8).trim();
      if (!displayName) {
        console.log('Usage: /reject <display name>');
      } else {
        const foundFullname = findFullnameByDisplayName(displayName, friendRequests);
        if (!foundFullname) {
          console.log(`No friend request found from "${displayName}"`);
        } else {
          const result = rejectFriendRequest(foundFullname);
          console.log(result.message);
        }
      }
    } else if (input === '/friends') {
      if (friends.size === 0) {
        console.log('You have no friends yet');
      } else {
        console.log(`Your friends (${friends.size}):`);
        for (const [fullname, data] of friends.entries()) {
          const statusIcon = isFriendOnline(fullname) ? '🟢' : '⚫';
          console.log(`  ${statusIcon} ${data.displayName} (${fullname})`);
        }
      }
    } else if (input.startsWith('/msg ')) {
      const parts = input.slice(5).trim().split(' ');
      if (parts.length < 2) {
        console.log('Usage: /msg <display name> <message>');
      } else {
        const displayName = parts[0];
        const message = parts.slice(1).join(' ');
        const foundFullname = findFullnameByDisplayName(displayName, friends);
        
        if (!foundFullname) {
          console.log(`Friend "${displayName}" not found. Use /friends to see your friends list`);
        } else {
          const result = sendMessage(foundFullname, message, node);
          console.log(result.message);
        }
      }
    } else if (input.startsWith('/creategroup ')) {
      const groupName = input.slice(13).trim();
      if (!groupName) {
        console.log('Usage: /creategroup <name>');
      } else {
        const result = createGroup(groupName);
        console.log(result.message);
      }
    } else if (input.startsWith('/invitegroup ')) {
      const args = input.slice(13).trim();
      const firstSpaceIndex = args.indexOf(' ');
      if (firstSpaceIndex === -1) {
        console.log('Usage: /invitegroup <group name> <display name>');
      } else {
        const groupName = args.slice(0, firstSpaceIndex);
        const displayName = args.slice(firstSpaceIndex + 1).trim();
        if (!displayName) {
          console.log('Usage: /invitegroup <group name> <display name>');
        } else {
          const result = inviteToGroup(groupName, displayName, node);
          console.log(result.message);
        }
      }
    } else if (input === '/groupinvites') {
      const invites = [...groups.entries()]
        .filter(([groupId, group]) => group.invitations.some(i => i.fullname === myProfile.fullname))
        .map(([groupId, group]) => ({ groupId, ...group }));
      
      if (invites.length === 0) {
        console.log('No pending group invitations');
      } else {
        console.log('Pending group invitations:');
        invites.forEach(group => {
          console.log(`  "${group.name}" - from ${group.creatorName}`);
        });
      }
    } else if (input.startsWith('/joingroup ')) {
      const groupName = input.slice(11).trim();
      if (!groupName) {
        console.log('Usage: /joingroup <group name>');
      } else {
        const result = acceptGroupInvite(groupName, node);
        console.log(result.message);
      }
    } else if (input.startsWith('/rejectgroup ')) {
      const groupName = input.slice(13).trim();
      if (!groupName) {
        console.log('Usage: /rejectgroup <group name>');
      } else {
        const result = rejectGroupInvite(groupName);
        console.log(result.message);
      }
    } else if (input === '/groups') {
      const myGroups = [...groups.entries()]
        .filter(([groupId, group]) => group.participants.some(p => p.fullname === myProfile.fullname))
        .map(([groupId, group]) => ({ groupId, ...group }));
      
      if (myGroups.length === 0) {
        console.log('You are not in any groups');
      } else {
        console.log('Your groups:');
        myGroups.forEach(group => {
          console.log(`  "${group.name}"`);
          console.log(`    Participants: ${group.participants.map(p => p.name).join(', ')}`);
        });
      }
    } else if (input.startsWith('/groupmsg ')) {
      const args = input.slice(10).trim();
      const firstSpaceIndex = args.indexOf(' ');
      if (firstSpaceIndex === -1) {
        console.log('Usage: /groupmsg <group name> <message>');
      } else {
        const groupName = args.slice(0, firstSpaceIndex);
        const message = args.slice(firstSpaceIndex + 1).trim();
        if (!message) {
          console.log('Usage: /groupmsg <group name> <message>');
        } else {
          const result = sendGroupMessage(groupName, message, node);
          console.log(result.message);
        }
      }
    } else if (input.startsWith('/leavegroup ')) {
      const groupName = input.slice(12).trim();
      if (!groupName) {
        console.log('Usage: /leavegroup <group name>');
      } else {
        const result = leaveGroup(groupName, node);
        console.log(result.message);
      }
    } else if (input === '/quit') {
      rl.close();
      await node.stop();
      process.exit(0);
    } else if (input.length > 0) {
      console.log('Unknown command. Use /help to see avalible commands');
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    console.log('\nQuitting');
    await node.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
