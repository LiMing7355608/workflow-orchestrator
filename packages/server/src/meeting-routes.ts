import { realpath } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createMeetingSchema, MeetingError, meetingNoteSchema, updateMeetingSchema, type Meetings } from './meetings.js';

export function registerMeetingRoutes(app: FastifyInstance, meetings: Meetings, actor: (headers: FastifyRequest['headers']) => string, specRoot: (id: string) => string | undefined,
  linkedRun: (room: ReturnType<Meetings['get']>) => string | undefined) {
  async function respond<T>(reply: FastifyReply, action: () => T | Promise<T>) {
    try { return await action(); }
    catch (error) {
      if (error instanceof MeetingError) return reply.code(error.code).send({ message: error.message });
      throw error;
    }
  }
  app.get<{ Querystring: { specId?: string } }>('/api/meetings', (request) => meetings.list(request.query.specId));
  app.post('/api/meetings', async (request, reply) => {
    const input = createMeetingSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ message: '请检查议题、产物目录、主持人及成员设置。' });
    return respond(reply, async () => {
      if (input.data.sourceSpecId) {
        const root = specRoot(input.data.sourceSpecId);
        if (!root || await realpath(input.data.workspaceRoot).catch(() => '') !== root) {
          throw new MeetingError('规格访谈与会议的项目目录必须一致。', 422);
        }
      }
      return reply.code(201).send(await meetings.create(input.data));
    });
  });
  app.get<{ Params: { id: string } }>('/api/meetings/:id', (request, reply) =>
    respond(reply, () => {
      const room = meetings.get(request.params.id);
      return { ...room, linkedRunId: linkedRun(room) };
    }));
  app.post<{ Params: { id: string } }>('/api/meetings/:id/settings', (request, reply) => {
    const input = updateMeetingSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ message: '请检查会议议题和成员设置。' });
    return respond(reply, () => meetings.configure(request.params.id, input.data));
  });
  app.post<{ Params: { id: string } }>('/api/meetings/:id/note', (request, reply) => {
    const input = meetingNoteSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ message: '请先输入发言。' });
    return respond(reply, () => meetings.note(request.params.id, actor(request.headers), input.data.text));
  });
  app.post<{ Params: { id: string } }>('/api/meetings/:id/interrupt', (request, reply) => {
    const input = meetingNoteSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ message: '请先输入要插入的指令。' });
    return respond(reply, async () => {
      await meetings.note(request.params.id, actor(request.headers), input.data.text);
      return meetings.pause(request.params.id);
    });
  });
  for (const action of ['organize', 'discuss', 'summarize'] as const) {
    app.post<{ Params: { id: string } }>(`/api/meetings/:id/${action}`, (request, reply) =>
      respond(reply, () => meetings.start(request.params.id, action)));
  }
  app.post<{ Params: { id: string } }>('/api/meetings/:id/pause', (request, reply) =>
    respond(reply, () => meetings.pause(request.params.id)));
  app.get<{ Params: { id: string } }>('/api/meetings/:id/report', (request, reply) => respond(reply, () => {
    const room = meetings.get(request.params.id);
    if (!room.report) return reply.code(404).send({ message: '该会议尚未产出方案。' });
    return reply.header('Content-Disposition', 'attachment; filename="solution.md"')
      .type('text/markdown; charset=utf-8').send(room.report + '\n');
  }));
}
