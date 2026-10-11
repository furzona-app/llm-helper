import { gguf, GGUFParseOutput } from "@huggingface/gguf"
import { BaseLoadModelOpts, Chat, ChatMessage, FileHandle, LLMActionOpts, LLMLoadModelConfig, LLMPredictionOpts, LLMPredictionStats, LLMToolParameters, LMStudioClient, LMStudioClientConstructorOpts, LLM as LMStudioLLM, Tool, tool } from "@lmstudio/sdk";
import z, { ZodAny, ZodRawShape } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Template } from "@huggingface/jinja";
import { randomUUID } from "crypto";

function applyJinjaTemplate(template: string, vars: {messages?: object[], tools?: object[], add_generation_prompt?: boolean, [varName: string]: any}) : string {
  return new Template(template).render({
    ...vars,
    messages: vars?.messages ?? [],
    tools: vars?.tools ?? null,
    add_generation_prompt: vars?.add_generation_prompt ?? true
  });
}

function getLMSStats(stats: LLMPredictionStats): LLMMessageStats {
  return stats;
}



class LLM {
  path?: string;
  gguf?: GGUFParseOutput;
  id?: string;
  toolPrompt: (tools: (LLMTool | Tool)[]) => string;
  lastEngine?: "lmstudio" | "llamafile";
  lmsClient?: LMStudioClient;
  lmsModel?: LMStudioLLM;
  lmsModelOpts?: BaseLoadModelOpts<LLMLoadModelConfig>;

  constructor();
  constructor(path: string);
  constructor(path?: string) {
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

  async load(): Promise<void> {
    if (typeof this.path != "string") {
      throw new TypeError("`path` is not a string");
    }

    this.gguf = await gguf(this.path, {allowLocalFile: true});
    this.id = (this.gguf?.metadata as Record<string, any> | undefined)?.["general.name"]?.replaceAll(" ", "-").toLowerCase();
  }

  async loadLMStudio(): Promise<void>;
  async loadLMStudio(modelOpts: BaseLoadModelOpts<LLMLoadModelConfig>): Promise<void>;
  async loadLMStudio(modelOpts: BaseLoadModelOpts<LLMLoadModelConfig>, clientOpts: LMStudioClientConstructorOpts): Promise<void>;
  async loadLMStudio(modelOpts?: BaseLoadModelOpts<LLMLoadModelConfig>, clientOpts?: LMStudioClientConstructorOpts): Promise<void> {
    if (typeof this.id != "string") {
      throw new Error("`id` is not a string; call `load` first");
    }

    this.lmsClient = new LMStudioClient(clientOpts);
    this.lmsModel = await this.lmsClient.llm.model(this.id, modelOpts);
    this.lmsModelOpts = modelOpts;
    this.lastEngine = "lmstudio";
  }

  chat(): LLMChat;
  chat(messages: LLMMessage[] | {role?: "system" | "user" | "assistant" | "tool", content: string}[]): LLMChat;
  chat(messages?: (LLMMessage | {role?: "system" | "user" | "assistant" | "tool", content: string} | string)[]): LLMChat {
    const chat = new LLMChat(this);

    if (messages instanceof Array) {
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];

        if (message instanceof LLMMessage || typeof message == "string") {
          chat.addMessage(message);
        } else if (typeof message.content == "string") {
          chat.addMessage(new LLMMessage(message.role, message.content));
        }
      }
    }

    return chat;
  }

  async complete(prompt: string): Promise<string>;
  async complete(prompt: string, opts: LLMCompletionPromptOptions): Promise<string>;
  async complete(prompt: string, opts?: LLMCompletionPromptOptions): Promise<string> {
    let text = prompt;
    let engine = this.lastEngine;
    let maxTokens = undefined;

    if (typeof opts == "object") {
      if (typeof opts.prompt == "object") {
        text = opts.prompt.text ?? prompt;
      } else {
        text = opts.prompt ?? prompt;
      }

      engine = opts.engine ?? this.lastEngine;
      maxTokens = opts.maxTokens;
    }

    if (engine == "lmstudio") {
      if (!this.lmsModel) {
        throw new Error("LM Studio model is not loaded");
      }

      const options = opts?.lmStudio?.completionOptions ?? {};
      
      if (opts?.onFirstToken) {
        options.onFirstToken = () => {
          if (typeof opts.lmStudio?.completionOptions?.onFirstToken == "function") {
            opts.lmStudio.completionOptions.onFirstToken();
          }

          opts.onFirstToken!();
        };
      }

      if (opts?.onToken) {
        options.onPredictionFragment = (fragment) => {
          if (typeof opts.lmStudio?.completionOptions?.onPredictionFragment == "function") {
            opts.lmStudio.completionOptions.onPredictionFragment(fragment);
          }

          opts.onToken!(fragment.content);
        };
      }

      if (maxTokens != undefined) {
        options.maxTokens = maxTokens;
      }
      
      let completed;
      try {
        completed = await this.lmsModel.complete(text, options);
      } catch (e: any) {
        if (typeof e.message == "string" && e.message.trim().includes("Cannot find model of instance reference. The model might have already been unloaded.") && (opts?.lmStudio?.autoReload === undefined || opts?.lmStudio?.autoReload) && typeof this.id == "string") {
          this.lmsModel = await this.lmsClient!.llm.model(this.id, this.lmsModelOpts);
          completed = await this.lmsModel.complete(text, options);
        } else {
          throw e;
        }
      }
      
      opts?.onFinished?.(completed.content);
      
      return completed.content;
    } else {
      throw new Error("Engine unsupported");
    }
  }

  toolToJson(tool: LLMTool | Tool) {
    const parameters = "parameters" in tool ? zodToJsonSchema(z.object(tool.parameters as ZodRawShape)) : (tool as any).customParameters;
    if (parameters) {
      delete parameters.$schema;
    }

    return {
      name: (tool as any).id,
      description: tool.description,
      parameters
    };
  }

  applyChatTemplate(vars: {messages?: object[], tools?: object[], add_generation_prompt?: boolean, [varName: string]: any}) : string {
    if (!this.gguf?.metadata) {
      throw new Error("`gguf` is unavailable; call `load` first");
    }

    if (typeof (this.gguf.metadata as Record<string, any>)["tokenizer.chat_template"] != "string") {
      throw new Error("This model's chat template is unavailable (is it an LLM?)");
    }

    return applyJinjaTemplate((this.gguf.metadata as Record<string, any>)["tokenizer.chat_template"], vars);
  }
}

class LLMChat {
  model?: LLM;
  messages: LLMMessage[];
  generating: boolean;
  #imageHandles: {[id: string]: FileHandle};

  constructor();
  constructor(model: LLM);
  constructor(model?: LLM) {
    this.model = model;
    this.messages = [];
    this.generating = false;
    this.#imageHandles = {};
  }

  clearCache() {
    this.#imageHandles = {};
  }

  clone() {
    const chat = new LLMChat();

    for (let i = 0; i < this.messages.length; i++) {
      chat.addMessage(this.messages[i].clone());
    }

    return chat;
  }

  addMessage(message: LLMMessage | string): LLMMessage {
    if (message instanceof LLMMessage) {
      if (message.role === undefined) {
        message.resolveRole(this.messages);
      }

      this.messages.push(message);
      
      return message;
    } else if (typeof message == "string") {
      const newMessage = new LLMMessage(message);
      newMessage.resolveRole(this.messages);
      this.messages.push(newMessage);
      
      return newMessage;
    } else {
      throw new TypeError("`message` must be an LLMMessage or string");
    }
  }

  addMessages(messages: (LLMMessage | string)[]): void {
    if (!(messages instanceof Array)) {
      return;
    }

    for (let i = 0; i < messages.length; i++) {
      this.addMessage(messages[i]);
    }
  }
  
  async prompt(prompt: string | null): Promise<LLMMessage[]>;
  async prompt(prompt: string | null, opts: LLMChatPromptOptions): Promise<LLMMessage[]>;
  async prompt(prompt: string | null, opts?: LLMChatPromptOptions): Promise<LLMMessage[]> {
    if (!(this.model instanceof LLM)) {
      throw new Error("`model` is not a valid model");
    }

    const tools: (LLMTool | Tool)[] = [];
    let nativeLevel = 0;
    let text = prompt;
    let role = "user";
    let engine = this.model.lastEngine;
    let vars = {};
    let maxTokens = undefined;
    let images: LLMImage[] = [];

    if (typeof opts == "object") {
      if (typeof opts.prompt == "object") {
        text = opts.prompt.text ?? prompt;
        role = opts.prompt.role ?? "user";
        nativeLevel = opts.prompt.nativeLevel ?? 0;
        vars = opts.prompt.vars ?? {};
        images = opts.prompt.images ?? [];
      } else {
        text = opts.prompt ?? prompt;
      }

      engine = opts.engine ?? this.model.lastEngine;
      maxTokens = opts.maxTokens;

      for (let i = 0; i < (opts?.tools?.length ?? 0); i++) {
        const toolOpts = opts.tools![i];

        if (engine == "lmstudio") {
          if (nativeLevel == 0) {
            const lmsTool = tool({
              name: toolOpts.id,
              description: toolOpts.description,
              parameters: toolOpts.parameters ?? {},
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
          } else {
            tools.push(toolOpts);
          }
        } else if (engine == "llamafile") {
          tools.push(toolOpts);
        } else if (engine == undefined) {
          throw new Error("No engine loaded");
        } else {
          throw new Error("Unknown engine '" + engine + "'");
        }
      }
    }
    
    const result: LLMMessage[] = [];

    if (engine == "lmstudio") {
      if (!this.model.lmsModel) {
        throw new Error("LM Studio model is not loaded");
      }
    }

    if (this.generating) {
      throw new Error("Chat can only do one generation at a time (use `clone()` for multiple generations)");
    }

    this.generating = true;
    if (text != null) {
      this.addMessage(new LLMMessage(role, text).withImages(...images));
    }
    
    let lastMessageIndex = -1;
    const isNewMessage = () => {
      if (result.length > lastMessageIndex) {
        lastMessageIndex = result.length;
        return true;
      }

      return false;
    };

    if (engine == "lmstudio") {
      if (nativeLevel == 0 || nativeLevel == 1) {
        let messages = [...this.messages.map((message) => ({role: message.role, content: message.content}))];

        if (nativeLevel == 1) {
          if (messages.length > 0 && messages[0].role == "system") {
            messages[0].content += this.model.toolPrompt(tools);
          } else {
            messages.unshift({role: "system", content: "You are a helpful assistant." + this.model.toolPrompt(tools)});
          }
        }
        
        const options = {...(opts?.lmStudio?.chatOptions ?? {})};
        let lastStats: LLMMessageStats | undefined;

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
            content += `<tool_call>\n${JSON.stringify({name: req.name, arguments: req.arguments})}\n</tool_call>`;
          }

          if (toolResponses.length == 1 && role == "tool") {
            content = toolResponses[0].content;
          } else {
            for (let i = 0; i < toolResponses.length; i++) {
              const res = toolResponses[i];
              content += `${content == "" ? "" : "\n\n"}<tool_response>\n${res.content}\n</tool_response>`;
            }
          }

          const newMessage = new LLMMessage(role, content);

          if (lastStats !== undefined) {
            newMessage.stats = lastStats;
            lastStats = undefined;
          }

          result.push(newMessage);
          this.addMessage(newMessage);
        };

        options.onPredictionCompleted = (prediction) => {
          if (result.length > 0) {
            result[result.length - 1].stats = getLMSStats(prediction.stats);
          } else {
            lastStats = getLMSStats(prediction.stats);
          }
        };

        if (opts?.onFirstToken) {
          let started = false;

          options.onFirstToken = (roundIndex) => {
            if (typeof opts.lmStudio?.chatOptions?.onFirstToken == "function") {
              opts.lmStudio.chatOptions.onFirstToken(roundIndex);
            }

            if (!started) {
              started = true;
              opts.onFirstToken!();
            }
          };
        }

        if (opts?.onToken) {
          options.onPredictionFragment = (fragment) => {
            if (typeof opts.lmStudio?.chatOptions?.onPredictionFragment == "function") {
              opts.lmStudio.chatOptions.onPredictionFragment(fragment);
            }

            opts.onToken!(fragment.content, {messageIndex: result.length, isNewMessage: isNewMessage(), isToolCall: false});
          };
          
          options.onToolCallRequestStart = (roundIndex, callId, info) => {
            if (typeof opts.lmStudio?.chatOptions?.onToolCallRequestStart == "function") {
              opts.lmStudio.chatOptions.onToolCallRequestStart(roundIndex, callId, info);
            }

            opts.onToken!("<tool_call>\n", {messageIndex: result.length, isNewMessage: isNewMessage(), isToolCall: true});
          };
          
          options.onToolCallRequestNameReceived = (roundIndex, callId, name) => {
            if (typeof opts.lmStudio?.chatOptions?.onToolCallRequestNameReceived == "function") {
              opts.lmStudio.chatOptions.onToolCallRequestNameReceived(roundIndex, callId, name);
            }

            opts.onToken!("{\"name\":" + JSON.stringify(name) + ",\"arguments\":", {messageIndex: result.length, isNewMessage: isNewMessage(), isToolCall: true});
          };
          
          options.onToolCallRequestArgumentFragmentGenerated = (roundIndex, callId, content) => {
            if (typeof opts.lmStudio?.chatOptions?.onToolCallRequestArgumentFragmentGenerated == "function") {
              opts.lmStudio.chatOptions.onToolCallRequestArgumentFragmentGenerated(roundIndex, callId, content);
            }

            opts.onToken!(content, {messageIndex: result.length, isNewMessage: isNewMessage(), isToolCall: true});
          };
          
          options.onToolCallRequestFinalized = (roundIndex, callId, info) => {
            if (typeof opts.lmStudio?.chatOptions?.onToolCallRequestFinalized == "function") {
              opts.lmStudio.chatOptions.onToolCallRequestFinalized(roundIndex, callId, info);
            }

            opts.onToken!("}\n</tool_call>", {messageIndex: result.length, isNewMessage: isNewMessage(), isToolCall: true});
          };
        }

        if (maxTokens != undefined) {
          options.maxTokens = maxTokens;
        }

        const lmsImages = async (images: LLMImage[]): Promise<FileHandle[] | undefined> => {
          const result: FileHandle[] = [];

          for (let i = 0; i < images.length; i++) {
            const image = images[i];
            
            if (image.id == undefined) {
              image.id = randomUUID();
            } else if (this.#imageHandles[image.id]) {
              result.push(this.#imageHandles[image.id]);
              continue;
            }
            
            if (image.type == "file") {
              result.push(this.#imageHandles[image.id] = await this.model!.lmsClient!.files.prepareImage(image.content));
            } else if (image.type == "base64") {
              result.push(this.#imageHandles[image.id] = await this.model!.lmsClient!.files.prepareImageBase64(image.name ?? `${image.id}.png`, image.content));
            }
          }

          return result.length ? result : undefined;
        };
        
        const chat = Chat.empty();
        for (let i = 0; i < this.messages.length; i++) {
          const message = this.messages[i];
          
          if (message.role == "tool") {
            chat.append(ChatMessage.from({role: "tool", content: [{type: "toolCallResult", content: message.content}]}));
          } else {
            chat.append({role: message.role, content: message.content, images: await lmsImages(message.images)});
          }
        }

        try {
          await this.model!.lmsModel!.act(chat, nativeLevel == 0 ? tools as Tool[] : [], options);
        } catch (e: any) {
          if (typeof e.message == "string" && e.message.trim().includes("Cannot find model of instance reference. The model might have already been unloaded.") && (opts?.lmStudio?.autoReload === undefined || opts?.lmStudio?.autoReload) && typeof this.model?.id == "string") {
            this.model.lmsModel = await this.model.lmsClient!.llm.model(this.model.id, this.model.lmsModelOpts);
            await this.model.lmsModel.act(chat, nativeLevel == 0 ? tools as Tool[] : [], options);
          } else {
            throw e;
          }
        }
      } else if (nativeLevel == 2) {
        const completionPrompt = this.model.applyChatTemplate({
          messages: this.messages.map((message) => ({role: message.role, content: message.content})),
          tools: tools.map((tool) => this.model!.toolToJson(tool)),
          add_generation_prompt: true,
          ...vars
        });

        const options = {...(opts?.lmStudio?.completionOptions ?? {})};

        if (opts?.onFirstToken) {
          options.onFirstToken = () => {
            if (typeof opts.lmStudio?.completionOptions?.onFirstToken == "function") {
              opts.lmStudio.completionOptions.onFirstToken();
            }

            opts.onFirstToken!();
          };
        }

        if (opts?.onToken) {
          options.onPredictionFragment = (fragment) => {
            if (typeof opts.lmStudio?.completionOptions?.onPredictionFragment == "function") {
              opts.lmStudio.completionOptions.onPredictionFragment(fragment);
            }

            opts.onToken!(fragment.content, {messageIndex: result.length, isNewMessage: isNewMessage(), isToolCall: false});
            lastMessageIndex = result.length;
          };
        }

        if (maxTokens != undefined) {
          options.maxTokens = maxTokens;
        }
        
        let completed;
        try {
          completed = await this.model!.lmsModel!.complete(completionPrompt, options);
        } catch (e: any) {
          if (typeof e.message == "string" && e.message.trim().includes("Cannot find model of instance reference. The model might have already been unloaded.") && (opts?.lmStudio?.autoReload === undefined || opts?.lmStudio?.autoReload) && typeof this.model?.id == "string") {
            this.model.lmsModel = await this.model.lmsClient!.llm.model(this.model.id, this.model.lmsModelOpts);
            completed = await this.model.lmsModel.complete(completionPrompt, options);
          } else {
            throw e;
          }
        }

        const newMessage = new LLMMessage("assistant", completed.content);
        newMessage.stats = getLMSStats(completed.stats);
        result.push(newMessage);
        this.addMessage(newMessage);
      }
    } else {
      throw new Error("Engine unsupported");
    }

    this.generating = false;
    opts?.onFinished?.(result);
    
    return result;
  }
}

class LLMMessage {
  role?: "system" | "user" | "assistant" | "tool";
  content: string;
  images: LLMImage[];
  stats?: LLMMessageStats;

  constructor(content?: string);
  constructor(role?: string, content?: string);
  constructor(firstArg?: string, secondArg?: string) {
    let role = firstArg;
    let content = secondArg;

    if (secondArg === undefined) {
      role = undefined;
      content = firstArg;
    }

    if (firstArg !== undefined && role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
      role = undefined;
    }

    this.role = role as "system" | "user" | "assistant" | "tool" | undefined;
    this.content = content ?? "";
    this.images = [];
  }

  withImages(...images: LLMImage[]): LLMMessage {
    this.images.push(...images);

    return this;
  }

  clone(): LLMMessage {
    return new LLMMessage(this.role, this.content);
  }

  resolveRole(history: LLMMessage[]): void {
    if (history.length > 0 && (history[history.length - 1]?.role == "user" || history[history.length - 1]?.role == "tool")) {
      this.role = "assistant";
    }

    this.role = "user";
  }
}

type LLMMessageStats = LLMPredictionStats;

type LLMImage = {
  /** The type of image link (file or base64). */
  type: "file" | "base64",
  /** ID of the image. This field is automatically filled by llm-helper and used for caching the file handle. */
  id?: string
} & (LLMImageFile | LLMImageBase64);

interface LLMImageFile {
  type: "file",
  /** The file path. */
  content: string,
  /** ID of the image. This field is automatically filled by llm-helper and used for caching the file handle. */
  id?: string
}

interface LLMImageBase64 {
  type: "base64",
  /**
   * The filename. You only have to specify this if using `base64` type.
   * If this is not done, a random filename will be assigned.
   */
  name?: string,
  /** The base64 stream. */
  content: string
}

interface LLMTool {
  /** The identifier the model will see and call. */
  id: string,
  /** The tool display name. This is not sent anywhere. */
  name?: string,
  /** The description of the tool, so the model knows what it is and what to use it for. */
  description: string,
  /**
   * The parameter schema required by the tool, using Zod. This is the recommended way to supply
   * parameter schemas and always takes precedence over `customParameter`.
   */
  parameters?: {[param: string]: ZodAny},
  /**
   * The parameter schema required by the tool, but in freeform. This allows you to use pure JSON
   * to supply the schemas in any way that you'd like. This schema is only used when `nativeLevel`
   * is `1` or `2` and `parameters` is not an object.
   */
  customParameters?: {[param: string]: object},
  /** The tool call. */
  call: (params: {[parameter: string]: any}) => string | null | undefined
}

interface LLMChatPromptOptions {
  /** The prompt settings. */
  prompt?: string | {
    /** The prompt text. */
    text?: string,
    /** The role. This should always either be "user" or "tool" to prevent confusing the model. */
    role?: "system" | "user" | "assistant" | "tool",
    /** Images to send with the message. */
    images?: LLMImage[],
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
    nativeLevel?: 0 | 1 | 2,
    /**
     * Custom chat template variables. These variables are applied when the messages are being
     * turned into text for the model to complete. Some models will allow the use of custom
     * variables to tweak a model's response, e.g. Qwen3's `enable_thinking` variable.
     * 
     * **Note: this will usually only work when `nativeLevel` is 2, as the chat template must be
     * managed manually instead of the engine automatically handling it.**
     */
    vars?: {
      [varName: string]: any
    }
  },

  /** Optional MCP servers to connect to the prompt. */
  mcpServers?: {
    [serverName: string]: {
      command?: string,
      args?: string[],
      url?: string,
      env?: {
        [name: string]: string
      },
      headers?: {
        [name: string]: string
      },
      timeout?: number
    }
  },

  /** Optional tools to make available to the model. */
  tools?: LLMTool[],

  /**
   * Overrides the engine used for generation. By default, the engine used
   * is the one last loaded inside an `LLM` class. However, if you loaded multiple engines
   * (which you shouldn't but can), you can use this option to select a favorite.
   */
  engine?: null | "lmstudio" | "llamafile",

  // Universal generation options
  maxTokens?: number,
  onFirstToken?: () => any,
  onToken?: (token: string, metadata: {messageIndex: number, isNewMessage: boolean, isToolCall: boolean}) => any,
  onFinished?: (messages: LLMMessage[]) => any,

  /** LM Studio settings. */
  lmStudio?: {
    autoReload: boolean,
    chatOptions: LLMActionOpts,
    completionOptions: LLMPredictionOpts
  },

  /** Llamafile settings. */
  llamafile?: {

  }
}

interface LLMCompletionPromptOptions {
  /** The prompt settings. */
  prompt?: string | {
    /** The prompt text. */
    text?: string
  },

  /**
   * Overrides the engine used for generation to be LM Studio. By default, the engine used
   * is the one last loaded inside an `LLM` class. However, if you loaded multiple engines
   * (which you shouldn't but can), you can use this option to select a favorite/
   */
  engine?: null | "lmstudio" | "llamafile",

  // Universal generation options
  maxTokens?: number,
  onFirstToken?: () => any,
  onToken?: (token: string) => any,
  onFinished?: (text: string) => any,

  /** LM Studio settings. */
  lmStudio?: {
    autoReload: boolean,
    completionOptions: LLMPredictionOpts
  },

  /** Llamafile settings. */
  llamafile?: {
    
  }
}

export { LLM, LLMChat, LLMMessage, LLMTool, LLMChatPromptOptions, LLMCompletionPromptOptions, applyJinjaTemplate };