# llm-helper

`llm-helper` is a package for Node.js focusing on providing a single unified API for interacting with different LLM engines. **This package is incomplete and may contain bugs or behave unexpectedly. Use at your own risk (though, feel free to create an issue if something seems off).**

## Engines

Here are the different engines supported and how much is implemented:

| Engine    | Loading | Chat | Completion | Manual tool handling | Live callback |
| --------- | ------- | ---- | ---------- | -------------------- | ------------- |
| LM Studio | ✅       | ✅    | ❌          | ❌                    | ❌             |
| llamafile | ❌       | ❌    | ❌          | ❌                    | ❌             |

## To-Do

Here's a list of things that have to be done (high-to-low priority):

| Status | Feature              | Description                                                                                         |
| ------ | -------------------- | --------------------------------------------------------------------------------------------------- |
| ✅      | Tools                | Allow sending tools and make the tools get called upon request.                                     |
| ❌      | Completion           | Allow completing text instead of only being confined to full chats.                                 |
| ❌      | Manual tool handling | Handle tool calls manually. Especially needed for llamafile, since it doesn't support tool calling. |
| ❌      | MCP servers          | Allow sending MCP servers as tools (connect to server, gather tools, and call when requested).      |
| ❌      | Images               | Be able to send images in a chat.                                                                   |

## Usage

### Loading a model

There are two ways to load a model. First, the most complete way:

```js
const { LLM } = require("llm-helper");

(async function() {
  const llm = new LLM("./Qwen3-4B-Q4_K_M.gguf");
  await llm.load();

  // LM Studio
  await llm.loadLMStudio();
  // llamafile (not supported yet)
  await llm.loadLlamafile();
})();
```

Supplying a GGUF file is the recommended approach, as you may also use `nativeLevel: 2`, which constructs the chat template based on the loaded model.

The other way only works with LM Studio:

```js
const { LLM } = require("llm-helper");

(async function() {
  const llm = new LLM();
  llm.id = "qwen3-4b";

  // LM Studio
  await llm.loadLMStudio();
})();
```

You may also combine both methods, loading the GGUF first and then changing the ID (though there shouldn't be any need to).

### Creating a chat

You may create a chat like this:

```js
// Either:
const chat = llm.chat([
  {role: "system", content: "You are Qwen."}
]);

// Or:
const chat = llm.chat();
chat.addMessage(new LLMMessage("system", "You are Qwen."));
```

### Generating a message

```js
const messages = await chat.prompt("Who are you?");

for (let i = 0; i < messages.length; i++) {
  const message = messages[i];
  console.log(`\n${message.role}: ${message.content}`);
}
```

`messages` is an array of `LLMMessage` objects, usually containing only one assistant message. However, when an assistant calls a tool (and it is automatically handled by the engine), there may be an assistant message, a tool message, and another assistant message, for example.
