const { LLM, LLMMessage } = require("./dist/index");

(async function() {
  const llm = new LLM("./Qwen3-4B-Q4_K_M.gguf");
  await llm.load();
  await llm.loadLMStudio();
  
  const chat = llm.chat([
    {role: "system", content: "You are Qwen."}
  ]);
  const messages = await chat.prompt("Who are you?");
})();