hi, i have last two questions before we send a pr. 

1. Where does claude agent sdk save session? is that in the current working directory?
2. When i use the Electron app's node environment to run the agent (query), i saw a bash terminal launched in the desktop environment, and just gone quickly. Why? if the user provides their own node path, will it still appear?


Hi, can we start building the kiro-cli-instance.ts? we will spawn the agent and comminucate with it through ACP (agent client protocol) https://agentclientprotocol.com/get-started/introduction This is the SDK package npm install @agentclientprotocol/sdk

Similar to claude-instance, when the agent starts first, send a greeting message to his owner.


----

Hi, i want to make an improvement on the agent-connector. Essentially, we support different notifyLevel for each conversation. But currently, the agent-connector doesn't have a filter, even if the agent may set the notifyLevel to @mentions, it will still process all the message. You can take a look at the desktop app implementation /Users/pineapple/workspace/conduit/packages/desktop/src/main/main-websocket.ts, and i think we need the same logic in the NewioApp packages/connector/src/main/newio-app.ts. Before you start implementing, let me know your plan or any questions you have.

can you also help me audit the packages/sdk/src/errors.ts? make sure it align with /Users/pineapple/workspace/conduit/packages/client/src/errors.ts


next, can you help me create core directory under packages/connector/src, the core directory contains the core logic about agents, and it's independent from the electron framework. For instance, we can move packages/connector/src/main/instances and agent-runtime-manager.ts, agent-config-manager.ts, and newio-app.ts to core

okay, here is thing, the backend change is not ready yet, for now, let just assume 1 conversation = 1 session. And here is my proposed architecture for the connector app, the packages/connector/src/core/instances/base-agent-instance.ts and its subclasses instance is equivalent to one agent instance, it will manage multiple sessions, maintain the mapping between newio sessionId and the agent specific sessionId (correlationId), and has the ability to launch new session. Next, for kiro-cli agent type, each instance of packages/connector/src/core/instances/kiro-cli-acp-client.ts will be one session, we can rename it to kiro-cli-acp-client. The  base-agent-instance will be the hub/orchestrator, each 

Each agent instance has an NewioApp instance, the message queue, and a list of session. 

