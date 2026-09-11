import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";

const terminalRequest = z.object({
  operation: z.enum(["start", "read", "write", "resize", "restart", "kill"]),
  sessionId: z.string().regex(/^[a-z0-9-]{8,64}$/),
  data: z.string().max(65536).optional(),
  offset: z.number().int().nonnegative().max(1_000_000_000).default(0),
  cols: z.number().int().min(20).max(240).default(80),
  rows: z.number().int().min(6).max(120).default(24),
});

const terminalResponse = z.object({
  ok: z.boolean(),
  alive: z.boolean(),
  dataBase64: z.string(),
  nextOffset: z.number().int().nonnegative(),
  truncated: z.boolean(),
  command: z.string(),
  error: z.string().optional(),
});

export const Actions = {
  terminal: defineAction({
    request: terminalRequest,
    response: terminalResponse,
    privileged: [privileged.terminalSession],
    async handler(ctx, args) {
      return await ctx.executePrivileged(privileged.terminalSession, args);
    },
  }),
} satisfies ActionsModule;
