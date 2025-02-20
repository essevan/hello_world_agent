/**
 * Single File ReAct Agent Template (Deno)
 * 
 * This agent follows the ReACT (Reasoning + Acting) logic pattern, integrates with the OpenRouter API for LLM interactions,
 * and supports tool usage within a structured agent framework. It is designed as a single-file TypeScript script for Deno,
 * optimized for minimal latency in serverless environments like Fly.io and Supabase Edge Functions.
 * 
 * ## Setup
 * - Ensure you have a Deno runtime available (e.g., in your serverless environment).
 * - Set the environment variable `OPENROUTER_API_KEY` with your OpenRouter API key.
 * - (Optional) Set `OPENROUTER_MODEL` to specify the model (default is "openai/o3-mini-high").
 * - This script requires network access to call the OpenRouter API. When running with Deno, use `--allow-net` (and `--allow-env` to read env variables).
 * 
 * ## Deployment (Fly.io)
 * 1. Create a Dockerfile using a Deno base image (e.g. `denoland/deno:alpine`).
 *    - In the Dockerfile, copy this script into the image and use `CMD ["run", \"--allow-net\", \"--allow-env\", \"agent.ts\"]`.
 * 2. Set the `OPENROUTER_API_KEY` as a secret on Fly.io (e.g., `fly secrets set OPENROUTER_API_KEY=your_key`).
 * 3. Deploy with `fly deploy`. The app will start an HTTP server on port 8000 by default (adjust Fly.io config for port if needed).
 * 
 * ## Deployment (Supabase Edge Functions)
 * 1. Install the Supabase CLI and login to your project.
 * 2. Create a new Edge Function: `supabase functions new myagent`.
 * 3. Replace the content of the generated `index.ts` with this entire script.
 * 4. Ensure to add your OpenRouter API key: run `supabase secrets set OPENROUTER_API_KEY=your_key` for the function's environment.
 * 5. Deploy the function: `supabase functions deploy myagent --no-verify-jwt` (the `--no-verify-jwt` flag disables authentication if you want the function public).
 * 6. The function will be accessible at the URL provided by Supabase (e.g., `https://<project>.functions.supabase.co/myagent`).
 * 
 * ## Usage
 * Send an HTTP POST request to the deployed endpoint with a JSON body: `{ "query": "your question" }`.
 * The response will be a JSON object: `{ "answer": "the answer from the agent" }`.
 * 
 * ## Notes
 * - The agent uses LangGraph for workflow management and the ReACT pattern for reasoning.
 * - Tools are defined in the code (see the `tools` array). The model is instructed on how to use them.
 * - The OpenRouter API is used similarly to OpenAI's Chat Completion API. Make sure your model supports the desired functionality.
 * - This template is optimized for clarity and minimal dependencies. It avoids large libraries for faster cold starts.
 * - The workflow is structured using LangGraph's StateGraph for better state management and control flow.
 */

// Import dependencies
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { StateGraph, END } from "npm:@langchain/langgraph@0.1.1";

const API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const MODEL = Deno.env.get("OPENROUTER_MODEL") || "openai/o3-mini-high";

if (!API_KEY) {
  console.error("Error: OPENROUTER_API_KEY is not set in environment.");
  Deno.exit(1);
}

// Type definitions
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface Tool {
  name: string;
  description: string;
  run: (input: string) => Promise<string> | string;
}

interface AgentState {
  messages: ChatMessage[];
  tools: Tool[];
  current_step: number;
  final_answer?: string;
}

// Define available tools
const tools: Tool[] = [
  {
    name: "Calculator",
    description: "Performs arithmetic calculations. Usage: Calculator[expression]",
    run: (input: string) => {
      try {
        if (!/^[0-9.+\-*\/()\s]+$/.test(input)) {
          return "Invalid expression";
        }
        const result = Function("return (" + input + ")")();
        return String(result);
      } catch (err) {
        return "Error: " + (err as Error).message;
      }
    }
  },
  // Additional tools can be added here
  // {
  //   name: "YourTool",
  //   description: "Description of what the tool does.",
  //   run: async (input: string) => { ... }
  // }
];

// System prompt
const toolDescriptions = tools.map(t => `${t.name}: ${t.description}`).join("\n");
const systemPrompt = 
`You are a smart assistant with access to the following tools:
${toolDescriptions}

When answering the user, you may use the tools to gather information or calculate results.
Follow this format strictly:
Thought: <your reasoning here>
Action: <ToolName>[<tool input>]
Observation: <result of the tool action>
... (you can repeat Thought/Action/Observation as needed) ...
Thought: <final reasoning>
Answer: <your final answer to the user's query>

Only provide one action at a time, and wait for the observation before continuing. 
If the answer is directly known or once you have gathered enough information, output the final Answer.
`;

// OpenRouter API call function
async function callOpenRouter(messages: ChatMessage[]): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: messages,
      stop: ["Observation:"],
      temperature: 0.0
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: HTTP ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  const content: string | undefined = data.choices?.[0]?.message?.content;
  
  if (typeof content !== "string") {
    throw new Error("Invalid response from LLM (no content)");
  }
  
  return content;
}

// LangGraph workflow setup
const workflow = new StateGraph<AgentState>({
  channels: {
    state: "object",
    query: "string",
    final_answer: "string?"
  }
});

// Node: Parse input and decide next action
workflow.addNode("parse_input", async (state: AgentState) => {
  const reply = await callOpenRouter(state.messages);
  return {
    ...state,
    messages: [...state.messages, { role: "assistant", content: reply }]
  };
});

// Node: Execute tool if needed
workflow.addNode("tool_executor", async (state: AgentState) => {
  const lastMessage = state.messages[state.messages.length - 1];
  const actionMatch = lastMessage.content.match(/Action:\s*([^\[]+)\[([^\]]+)\]/);
  
  if (!actionMatch) {
    return state;
  }
  
  const [_, toolName, toolInput] = actionMatch;
  const tool = state.tools.find(t => t.name.toLowerCase() === toolName.trim().toLowerCase());
  let observation: string;
  
  if (!tool) {
    observation = `Tool "${toolName}" not found`;
  } else {
    try {
      const result = await tool.run(toolInput.trim());
      observation = String(result);
    } catch (err) {
      observation = `Error: ${(err as Error).message}`;
    }
  }
  
  return {
    ...state,
    messages: [...state.messages, { role: "system", content: `Observation: ${observation}` }]
  };
});

// Node: Generate response or continue
workflow.addNode("response_generator", async (state: AgentState) => {
  const lastMessage = state.messages[state.messages.length - 1];
  const answerMatch = lastMessage.content.match(/Answer:\s*(.*)$/);
  
  if (answerMatch) {
    return {
      ...state,
      final_answer: answerMatch[1].trim()
    };
  }
  
  return {
    ...state,
    current_step: state.current_step + 1
  };
});

// Add edges between nodes
workflow.addEdge("parse_input", "tool_executor");
workflow.addEdge("tool_executor", "response_generator");

// Add conditional edges for loop or completion
workflow.addConditionalEdges(
  "response_generator",
  (state) => {
    if (state.final_answer) return "end";
    if (state.current_step >= 10) return "end";
    return "continue";
  },
  {
    end: END,
    continue: "parse_input"
  }
);

// Compile the workflow
const graph = workflow.compile();

// Cyberpunk ASCII banner
console.log(`
\x1b[36m   ____  _____ _                     _   
  / ___||  ___/ \\   __ _  ___ _ __ | |_ 
  \\___ \\| |_ / _ \\ / _\` |/ _ \\ '_ \\| __|
   ___) |  _/ ___ \\ (_| |  __/ | | | |_ 
  |____/|_|/_/   \\_\\__, |\\___|_| |_|\\__|
                   |___/
    [NEURAL LINK ESTABLISHED]
    [AWAITING INTERFACE INPUT...]
\x1b[0m
`);

// HTTP server
serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response(JSON.stringify({
      message: "Welcome to the Single File ReAct Agent with LangGraph!",
      usage: "Send a POST request with JSON body: { \"query\": \"your question\" }"
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let query: string;
  try {
    const data = await req.json();
    query = data.query ?? data.question;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (!query || typeof query !== "string") {
    return new Response(`Bad Request: Missing "query" string.`, { status: 400 });
  }

  try {
    const result = await graph.invoke({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query }
      ],
      tools,
      current_step: 0
    });

    const responseData = { 
      answer: result.final_answer ?? "No answer generated within step limit." 
    };

    return new Response(JSON.stringify(responseData), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("Agent error:", err);
    const errorMsg = (err as Error).message || String(err);
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
