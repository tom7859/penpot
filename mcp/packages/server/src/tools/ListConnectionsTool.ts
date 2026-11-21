import { EmptyToolArgs, Tool } from "../Tool";
import "reflect-metadata";
import type { ToolResponse } from "../ToolResponse";
import { TextResponse } from "../ToolResponse";
import { PenpotMcpServer } from "../PenpotMcpServer";

export class ListConnectionsTool extends Tool<EmptyToolArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, EmptyToolArgs.schema);
    }

    public getToolName(): string {
        return "list_connections";
    }

    public getToolDescription(): string {
        return (
            "Lists the connected Penpot sessions (browser tabs running the MCP plugin): each one's sessionId, " +
            "the ID and name of the file it has open, its workspace state and when it connected. " +
            "Pass a fileName or fileId as `file`, or a sessionId as `sessionId`, to target a session in other tools."
        );
    }

    protected async executeCore(args: EmptyToolArgs): Promise<ToolResponse> {
        const sessions = await this.mcpServer.pluginBridge.listSessions();
        if (sessions.length === 0) {
            return new TextResponse("No Penpot sessions are connected.");
        }
        return new TextResponse(JSON.stringify(sessions, null, 2));
    }
}
