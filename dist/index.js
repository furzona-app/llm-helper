"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMMessage = exports.LLMChat = exports.LLM = void 0;
exports.applyJinjaTemplate = applyJinjaTemplate;
const gguf_1 = require("@huggingface/gguf");
const sdk_1 = require("@lmstudio/sdk");
const zod_1 = __importDefault(require("zod"));
const jinja_1 = require("@huggingface/jinja");
function applyJinjaTemplate(template, vars) {
    return new jinja_1.Template(template).render({
        ...vars,
        messages: vars?.messages ?? [],
        tools: vars?.tools ?? null,
        add_generation_prompt: vars?.add_generation_prompt ?? true
    });
}
;
class LLM {
    path;
    gguf;
    id;
    toolPrompt;
    lastEngine;
    lmsClient;
    lmsModel;
    constructor(path) {
        this.path = path;
        this.toolPrompt = (tools) => `

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${tools.map((tool) => JSON.stringify(this.toolToJson(tool))).join("\n")}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>`;
    }
    async load() {
        if (typeof this.path != "string") {
            throw new TypeError("`path` is not a string");
        }
        this.gguf = await (0, gguf_1.gguf)(this.path, { allowLocalFile: true });
        this.id = this.gguf?.metadata?.["general.name"]?.replaceAll(" ", "-").toLowerCase();
    }
    async loadLMStudio(modelOpts, clientOpts) {
        if (typeof this.id != "string") {
            throw new Error("`id` is not a string; call `load` first");
        }
        this.lmsClient = new sdk_1.LMStudioClient(clientOpts);
        this.lmsModel = await this.lmsClient.llm.model(this.id, modelOpts);
        this.lastEngine = "lmstudio";
    }
    chat(messages) {
        const chat = new LLMChat(this);
        if (messages instanceof Array) {
            for (let i = 0; i < messages.length; i++) {
                const message = messages[i];
                if (message instanceof LLMMessage || typeof message == "string") {
                    chat.addMessage(message);
                }
                else if (typeof message.content == "string") {
                    chat.addMessage(new LLMMessage(message.role, message.content));
                }
            }
        }
        return chat;
    }
    toolToJson(tool) {
        const parameters = tool.parameters ? zod_1.default.toJSONSchema(zod_1.default.object(tool.parameters)) : tool.customParameters;
        delete parameters.$schema;
        return {
            name: tool.id,
            description: tool.description,
            parameters
        };
    }
    applyChatTemplate(vars) {
        if (!this.gguf?.metadata) {
            throw new Error("`gguf` is unavailable; call `load` first");
        }
        if (typeof this.gguf.metadata["tokenizer.chat_template"] != "string") {
            throw new Error("This model's chat template is unavailable (is it an LLM?)");
        }
        return applyJinjaTemplate(this.gguf.metadata["tokenizer.chat_template"], vars);
    }
}
exports.LLM = LLM;
class LLMChat {
    model;
    messages;
    constructor(model) {
        this.model = model;
        this.messages = [];
    }
    addMessage(message) {
        if (message instanceof LLMMessage) {
            if (message.role === undefined) {
                message.resolveRole(this.messages);
            }
            this.messages.push(message);
            return message;
        }
        else if (typeof message == "string") {
            const newMessage = new LLMMessage(message);
            newMessage.resolveRole(this.messages);
            this.messages.push(newMessage);
            return newMessage;
        }
        else {
            throw new TypeError("`message` must be an LLMMessage or string");
        }
    }
    addMessages(messages) {
        if (!(messages instanceof Array)) {
            return;
        }
        for (let i = 0; i < messages.length; i++) {
            this.addMessage(messages[i]);
        }
    }
    async prompt(prompt, opts) {
        if (!(this.model instanceof LLM)) {
            throw new Error("`model` is not a valid model");
        }
        const tools = [];
        let nativeLevel = 0;
        let text = prompt;
        let role = "user";
        let engine = this.model.lastEngine;
        let vars = {};
        if (typeof opts == "object") {
            if (typeof opts.prompt == "object") {
                text = opts.prompt.text ?? prompt;
                role = opts.prompt.role ?? "user";
                nativeLevel = opts.prompt.nativeLevel ?? 0;
                vars = opts.prompt.vars ?? {};
            }
            else {
                text = opts.prompt ?? prompt;
            }
            engine = opts.engine ?? this.model.lastEngine;
            for (let i = 0; i < opts?.tools?.length; i++) {
                const toolOpts = opts.tools[i];
                if (engine == "lmstudio") {
                    if (nativeLevel == 0) {
                        const lmsTool = (0, sdk_1.tool)({
                            name: toolOpts.id,
                            description: toolOpts.description,
                            parameters: toolOpts.parameters,
                            implementation: (params) => {
                                const result = toolOpts.call?.(params);
                                return result == undefined ? [] : [
                                    {
                                        type: "text",
                                        text: result
                                    }
                                ];
                            }
                        });
                        tools.push(lmsTool);
                    }
                    else {
                        tools.push(toolOpts);
                    }
                }
                else if (engine == "llamafile") {
                    tools.push(toolOpts);
                }
                else if (engine == undefined) {
                    throw new Error("No engine loaded");
                }
                else {
                    throw new Error("Unknown engine '" + engine + "'");
                }
            }
        }
        const result = [];
        this.addMessage(new LLMMessage(role, prompt));
        if (engine == "lmstudio") {
            if (!this.model.lmsModel) {
                throw new Error("LM Studio model is not loaded");
            }
            if (nativeLevel == 0 || nativeLevel == 1) {
                let messages = [...this.messages.map((message) => ({ role: message.role, content: message.content }))];
                if (nativeLevel == 1) {
                    if (messages.length > 0 && messages[0].role == "system") {
                        messages[0].content += this.model.toolPrompt(tools);
                    }
                    else {
                        messages.unshift({ role: "system", content: "You are a helpful assistant." + this.model.toolPrompt(tools) });
                    }
                }
                const options = opts?.lmStudio?.chatOptions ?? {};
                options.onMessage = (message) => {
                    if (typeof opts?.lmStudio?.chatOptions?.onMessage == "function") {
                        opts.lmStudio.chatOptions.onMessage(message);
                    }
                    const role = message.getRole();
                    let content = message.getText();
                    const toolRequests = message.getToolCallRequests();
                    const toolResponses = message.getToolCallResults();
                    for (let i = 0; i < toolRequests.length; i++) {
                        const req = toolRequests[i];
                        content += `${content == "" ? "" : "\n"}<tool_call>\n${JSON.stringify({ name: req.name, arguments: req.arguments })}\n</tool_call>`;
                    }
                    if (toolResponses.length == 1 && role == "tool") {
                        content = toolResponses[0].content;
                    }
                    else {
                        for (let i = 0; i < toolResponses.length; i++) {
                            const res = toolResponses[i];
                            content += `${content == "" ? "" : "\n"}<tool_response>\n${res.content}\n</tool_response>`;
                        }
                    }
                    const newMessage = new LLMMessage(role, content);
                    result.push(newMessage);
                    this.addMessage(newMessage);
                };
                const chat = sdk_1.Chat.empty();
                for (let i = 0; i < this.messages.length; i++) {
                    const message = this.messages[i];
                    if (message.role == "tool") {
                        chat.append(sdk_1.ChatMessage.from({ role: "tool", content: [{ type: "toolCallResult", content: message.content }] }));
                    }
                    else {
                        chat.append(message.role, message.content);
                    }
                }
                await this.model.lmsModel.act(chat, nativeLevel == 0 ? tools : [], options);
            }
            else if (nativeLevel == 2) {
                const completionPrompt = this.model.applyChatTemplate({
                    messages: this.messages.map((message) => ({ role: message.role, content: message.content })),
                    tools: tools.map((tool) => this.model.toolToJson(tool)),
                    add_generation_prompt: true,
                    ...vars
                });
                const options = opts?.lmStudio?.completionOptions ?? {};
                const completed = await this.model.lmsModel.complete(completionPrompt, options);
                const newMessage = new LLMMessage("assistant", completed.content);
                result.push(newMessage);
                this.addMessage(newMessage);
            }
        }
        return result;
    }
}
exports.LLMChat = LLMChat;
class LLMMessage {
    role;
    content;
    constructor(role, content) {
        if (content === undefined) {
            content = role;
            role = undefined;
        }
        if (role !== undefined && role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
            role = undefined;
        }
        this.role = role;
        this.content = content;
    }
    resolveRole(history) {
        if (history.length > 0 && (history[history.length - 1]?.role == "user" || history[history.length - 1]?.role == "tool")) {
            this.role = "assistant";
        }
        this.role = "user";
    }
}
exports.LLMMessage = LLMMessage;
