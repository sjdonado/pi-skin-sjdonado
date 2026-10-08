import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { connectMcp } from "./mcp.ts";

test("code mode discovers MCP schemas and executes dependent calls in the sandbox", async () => {
  const source = `import {createInterface} from "node:readline";createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);if(!r.id)return;let result={};if(r.method==="initialize")result={protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"fake",version:"1"}};if(r.method==="tools/list")result={tools:[{name:"increment",description:"Increment a value",inputSchema:{type:"object",properties:{value:{type:"number"}},required:["value"]}}]};if(r.method==="tools/call")result={content:[{type:"text",text:"ok"}],structuredContent:{value:r.params.arguments.value+1}};console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result}));});`;
  const bridge = await connectMcp(process.cwd(), { fixture: { command: process.execPath, args: ["-e", source] } });
  const entries: unknown[] = [];
  const api = { conversationId: 1, commit: async (fn: any) => fn({ appendEntry: async (_id: number, entry: unknown) => { entries.push(entry); return entry; } }) };
  try {
    expect(bridge.status.fixture).toBe("1 tools");
    const tool = bridge.extension.tools![0];
    const result = await tool.execute({ code: `const found=await searchTools("increment"); const schema=await describeTool(found[0].name); const first=await tools[found[0].name]({value:1}); return await tools[found[0].name]({value:first.value});` }, api as any, ctx);
    expect(result.content?.at(-1)).toEqual({ type: "text", text: '{"value":3}' });
    expect(entries).toHaveLength(4);
  } finally { await bridge.close(); }
}, 15000);
