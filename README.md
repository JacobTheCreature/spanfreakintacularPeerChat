=== INSTALLATION STEPS ===

Install Node.js and npm
https://nodejs.org/en/download/package-manager

run node -v to verify 

run npm -v to verify

cd into the conf-chat folder

Install dependencies

run npm i

Start the program

node peerchat.js

=== RUNNING THE PROGRAM ===

As a new user you will be prompted to create a new account

provide your full name, display name (dont use spaces), and password

You will be provided with a multiaddr that looks something like

/ipv4/127.0.0.1/tcp/63887/p2p/12DD3KooW......

To connect to another node, copy this multiaddr and use /connect <multiaddr>

use /help to see the full list of commands

=== OVERVIEW ===

Here is an overview of the P2P architecture I have created.

Technology:
    - Node.js
    - npm

For my implementation I used a veriety of npm libraries:
    - libp2p                     Core P2P networking framework
    - @libp2p/tcp                TCP transport layer
    - @chainsafe/libp2p-noise    Connection encryption
    - @chainsafe/libp2p-yamux    Stream multiplexing
    - @libp2p/gossipsub          Pub/sub messaging
    - @libp2p/identify           Peer identification
    - @multiformats/multiaddr    Address formatting
    - readline                   CLI input handling
    - fs                         File system operations
    - bcrypt                     Password hashing

I kinda shot myself in the foot here with going the library route 
becuase I had to figure out what all libraries I needed and then 
figure out how they work in order to implement my P2P system. This was 
tedious and I relied heavily on AI example implementations in order 
to figure out how each library is used and how to custom talor it to 
my situation. 

I spent a lot of time trying to get this to be a fully functional 
P2P program with automatic discovery with bootstrap nodes for devices
on the same wifi network and even different wifi networks. However, I have 
simplified this greatly for only localhost connections with manual connection,
given your input from class. 

So, with that being said, what is my P2P system's core functionality?

1. Accounts
    - User registration provided a full name, display name, and password
    - User data is stored in json files on the machine
    - Passwords are encrypted

2. Peer-to-peer networking
    - Nodes are libp2p nodes on localhost
    - All traffic is TCP
    - Peers have peerIDs for identification and uniqueness
    - Nodes have a multiaddr for connections
    - Peers have real-time online/offline tracking

3. Friends
    - Send friend requests to connected peers
    - Accept/reject friend requests
    - See when friends are online/offline

4. Messaging 
    - Send messages in real-time to friends only
    - Queue messages for offline friends
    - Deliver queued offline messages when friend comes online

5. Group messaging
    - Create a conference chat
    - Invite friends to conferencce chat
    - Join/leave conferences
    - Messages sent in conference are sent to all participants
    - Messages send for a conference are also queued if a participant is offline
    - Deliver conference message to offline users when the come back online

6. Data storage
    - Information that is stored on the machine
        - Account info (fullname, displayname, and hashed password)
        - Friends
        - Conferences
        - Queued offline messages

7. Command line for interfacing
    - "/" commands for all functionality

Here are where my system falls short, intentially to lighten the load
on myself as I have already spent I feel too many hours on this.

1. No cross-network/LAN connects (local only)

2. No password changing 

3. No enforcing no spaces in display name (the display name "Jacob Schirmer" would need 
                                            to be "JacobSchirmer" to work properly)

4. No automatic peer discovery and connection
    I was able to do this for LAN connections but it was finicy and making
    my life difficult.

5. There can be duplicate display names

6. There can be duplicate conference names

What makes this P2P?

Well there is no central server, only nodes that connect to each other. There are no master nodes,
slave nodes, or some kind of intermediary service that handles traffic, authentication, processing, 
or storage. Messages are broadcasted across many peers but are only displayed to the intended user/s via a pub/sub
gossip implementation. I am broadcasting to all but only certain nodes can read it. Like 
if I were in a large room and gave everyone a note, but only those whose name is on the
cover can read it. That is how the messaging and updating system works.

=== AI ACKNOWLEDGEMENT ===

Data storage
    Storing and retreaving data via JSONs was my idea although I had never 
    implemented something like it before. However, it turned out to be straightforward
    and intuitive, plus it only makes up 5 small functions. After making the first 
    function, saving data to a JSON, I had AI expand on it for getting data and filtering.

Command line for interfacing
    When it came to the command line interfacing during testing AI had used the 
    readline.createInterface variable and that turned out to simlify a lot of 
    the command handling. The whole user interaction is one giant if-else statement 
    which while bulky and probably inefficient, was the easiset for me to follow and
    add to. AI built most of that, so I could focus on the actual Peer to peer logic. 

Optimization and Error checking

    I would run periodically run prompts such as:

    "Scan my file, are there redundancies, what logic could be simplified?"

    This lead to some function optimization and AI making useful helper
    functions to reduce line count.

Genral AI Use

- The configuration of the libp2p createNode() function
- Planning methods of addressing each core functionality
    - Like how to properly utilize the pub sub topic system
    - Properly using async, await, and promises
- Debugging/troubleshooting errors
