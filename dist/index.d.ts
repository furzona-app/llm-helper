import { GGUFParseOutput } from "@huggingface/gguf";
import { BaseLoadModelOpts, LLMActionOpts, LLMLoadModelConfig, LLMPredictionOpts, LMStudioClient, LMStudioClientConstructorOpts, LLM as LMStudioLLM } from "@lmstudio/sdk";
import z, { ZodAny } from "zod";
declare function applyJinjaTemplate(template: string, vars: {
    messages?: object[];
    tools?: object[];
    add_generation_prompt?: boolean;
    [varName: string]: any;
}): string;
declare class LLM {
    path?: string;
    gguf?: GGUFParseOutput;
    id?: string;
    toolPrompt: (tools: LLMTool[]) => string;
    lastEngine: "lmstudio" | "llamafile";
    lmsClient?: LMStudioClient;
    lmsModel?: LMStudioLLM;
    constructor();
    constructor(path: string);
    load(): Promise<void>;
    loadLMStudio(): Promise<void>;
    loadLMStudio(modelOpts: BaseLoadModelOpts<LLMLoadModelConfig>): Promise<void>;
    loadLMStudio(modelOpts: BaseLoadModelOpts<LLMLoadModelConfig>, clientOpts: LMStudioClientConstructorOpts): Promise<void>;
    chat(): LLMChat;
    chat(messages: LLMMessage[] | {
        role?: "system" | "user" | "assistant" | "tool";
        content: string;
    }[]): LLMChat;
    toolToJson(tool: LLMTool): {
        name: string;
        description: string;
        parameters: z.core.JSONSchema.JSONSchema | {
            [param: string]: object;
        };
    };
    applyChatTemplate(vars: {
        messages?: object[];
        tools?: object[];
        add_generation_prompt?: boolean;
        [varName: string]: any;
    }): string;
}
declare class LLMChat {
    model?: LLM;
    messages: LLMMessage[];
    constructor();
    constructor(model: LLM);
    addMessage(message: LLMMessage | string): LLMMessage;
    addMessages(messages: (LLMMessage | string)[]): void;
    prompt(prompt: string): Promise<LLMMessage[]>;
    prompt(prompt: string, opts: LLMPromptOptions): Promise<LLMMessage[]>;
}
declare class LLMMessage {
    role?: "system" | "user" | "assistant" | "tool";
    content: string;
    constructor(content: string);
    constructor(role: string, content: string);
    resolveRole(history: LLMMessage[]): void;
}
interface LLMTool {
    /** The identifier the model will see and call. */
    id: string;
    /** The tool display name. This is not sent anywhere. */
    name?: string;
    /** The description of the tool, so the model knows what it is and what to use it for. */
    description: string;
    /**
     * The parameter schema required by the tool, using Zod. This is the recommended way to supply
     * parameter schemas and always takes precedence over `customParameter`.
     */
    parameters?: {
        [param: string]: ZodAny;
    };
    /**
     * The parameter schema required by the tool, but in freeform. This allows you to use pure JSON
     * to supply the schemas in any way that you'd like. This schema is only used when `nativeLevel`
     * is `1` or `2` and `parameters` is not an object.
     */
    customParameters?: {
        [param: string]: object;
    };
    /** The tool call. */
    call: (params: {
        [parameter: string]: any;
    }) => string | null | undefined;
}
interface LLMPromptOptions {
    /** The prompt settings. */
    prompt?: string | {
        /** The prompt text. */
        text?: string;
        /** The role. This should always either be "user" or "tool" to prevent confusing the model. */
        role?: "system" | "user" | "assistant" | "tool";
        /**
         * Determines how the context and prompt should be formatted. There are 3 native levels:
         *
         * 0 - Fully utilize the chat functionality provided by the engine. This mode uses the chat
         * endpoint and sends messages, prompt settings and tools the intended way, making sure almost
         * nothing is computed manually. Tool calling is handled by the engine if supported.
         *
         * 1 - Utilize the chat functionality, but only send the messages and prompt settings. The
         * tool definitions are manually computed and put inside the system prompt. Tool calling is
         * handled by the engine if supported. This mode allows you to make up your own parameter
         * objects.
         *
         * 2 - Uses the completion endpoint to send the full context inside a single text, handling
         * everything manually.
         */
        nativeLevel?: 0 | 1 | 2;
        /**
         * Custom chat template variables. These variables are applied when the messages are being
         * turned into text for the model to complete. Some models will allow the use of custom
         * variables to tweak a model's response, e.g. Qwen3's `enable_thinking` variable.
         *
         * **Note: this will usually only work when `nativeLevel` is 2, as the chat template must be
         * managed manually instead of the engine automatically handling it.**
         */
        vars?: {
            [varName: string]: any;
        };
    };
    /** Optional MCP servers to connect to the prompt. */
    mcpServers?: {
        [serverName: string]: {
            command?: string;
            args?: string[];
            url?: string;
            env?: {
                [name: string]: string;
            };
            headers?: {
                [name: string]: string;
            };
            timeout?: number;
        };
    };
    /** Optional tools to make available to the model. */
    tools?: LLMTool[];
    /**
     * Overrides the engine used for generation to be LM Studio. By default, the engine used
     * is the one last loaded inside an `LLM` class. However, if you loaded multiple engines
     * (which you shouldn't but can), you can use this option to select a favorite/
     */
    engine?: null | "lmstudio" | "llamafile";
    /** LM Studio settings. */
    lmStudio?: {
        chatOptions: LLMActionOpts;
        completionOptions: LLMPredictionOpts;
    };
    /** Llamafile settings. */
    llamafile?: {};
}
export { LLM, LLMChat, LLMMessage, LLMTool, LLMPromptOptions, applyJinjaTemplate };
