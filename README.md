# llm-helper
`llm-helper` is a package for Node.js focusing on providing a single unified API for interacting with different LLM engines. **This package is incomplete and may contain bugs or behave unexpectedly. Use at your own risk (though, feel free to create an issue if you find something is off).**

## Engines
Here are the different engines supported, and how much is implemented:

| Engine | Loading | Chat | Completion | Manual tool handling |
| ------ | ------- | ---- | ---------- | -------------------- |
| LM Studio | ✅ | ✅ | ❌ | ❌ |
| llamafile | ❌ | ❌ | ❌ | ❌ |

## To-Do
Here's a list of things that have to be done (high to low priority):

| Status | Feature | Description |
| ----- | ------- | ----------- |
| ✅ | Tools | Allow sending tools, and make the tools get called upon request. |
| ❌ | Completion | Allow completing text instead of only being confined to full chats. |
| ❌ | Manual tool handling | Handle tool calling manually. Especially needed for llamafile, since llamafile doesn't support tool calling. |
| ❌ | MCP servers | Allow sending MCP servers as tools (connect to server, gather tools, and call when requested). |
| ❌ | Images | Be able to send images inside a chat. |