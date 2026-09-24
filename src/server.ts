import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import { parseIdentity } from './identity.js';
import { hashIdentity, signSession, verifySession } from './security.js';
import { ensureRoom, joinRoom, leaveRoom, listMessages, saveMessage, upsertIdentity } from './store.js';

const app = Fastify({ logger: true, trustProxy: true });
const port = Number(process.env.PORT ?? 8787);
const origin = process.env.PUBLIC_ORIGIN?.split(',').map((item) => item.trim()).filter(Boolean) ?? true;
const sendSchema = z.object({ body: z.string().trim().min(1).max(Number(process.env.MAX_MESSAGE_LENGTH ?? 500)) });
const socketRate = new Map<string, { count: number; at: number }>();

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(cors, { origin, credentials: false });
await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });

app.get('/', async () => ({ ok: true, service: 'gartic-online', health: '/health' }));
app.get('/health', async () => ({ ok: true, service: 'gartic-online', time: new Date().toISOString() }));
app.post('/v1/session/anonymous', async (request, reply) => {
  try {
    const identity = parseIdentity(request.body);
    const user = await upsertIdentity(identity);
    const roomDbId = await ensureRoom(identity.roomId);
    await joinRoom(roomDbId, user.id);
    const token = signSession({ sub: user.id, roomId: identity.roomId, provider: 'gartic.io', identityHash: hashIdentity([identity.roomId, identity.userId, identity.nickname]), nickname: user.nickname, avatar: user.avatar });
    return { token, user: { id: user.id, nickname: user.nickname, avatar: user.avatar }, roomId: identity.roomId };
  } catch (error) {
    request.log.warn({ error }, 'invalid session identity');
    return reply.code(400).send({ error: 'invalid_identity' });
  }
});

const io = new SocketIOServer(app.server, { cors: { origin, methods: ['GET', 'POST'] }, transports: ['websocket', 'polling'] });
io.use((socket, next) => {
  const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
  const claims = verifySession(token);
  if (!claims) return next(new Error('unauthorized'));
  socket.data.claims = claims;
  next();
});

io.on('connection', async (socket) => {
  const claims = socket.data.claims as { sub: string; roomId: string };
  socket.data.nickname = (socket.data.claims as { nickname: string }).nickname;
  socket.data.avatar = (socket.data.claims as { avatar?: string }).avatar;
  const roomKey = `gartic.io:${claims.roomId}`;
  const roomDbId = await ensureRoom(claims.roomId);
  await joinRoom(roomDbId, claims.sub);
  await socket.join(roomKey);
  socket.emit('room:ready', { roomId: claims.roomId, history: await listMessages(roomDbId) });
  socket.to(roomKey).emit('room:presence', { type: 'join', userId: claims.sub, nickname: socket.data.nickname });
  socket.on('identity:confirm', (proof: unknown) => {
    const candidate = z.object({ roomId: z.string().min(1), userId: z.string().min(1), nickname: z.string().min(1) }).safeParse(proof);
    if (!candidate.success || candidate.data.roomId !== claims.roomId || hashIdentity([candidate.data.roomId, candidate.data.userId, candidate.data.nickname]) !== (socket.data.claims as { identityHash: string }).identityHash) {
      socket.emit('session:rejected', { error: 'identity_mismatch' });
      socket.disconnect(true);
    }
  });
  socket.on('chat:send', async (payload: unknown, callback?: (result: unknown) => void) => {
    const now = Date.now();
    const current = socketRate.get(socket.id);
    const next = !current || now - current.at > 10_000 ? { count: 1, at: now } : { count: current.count + 1, at: current.at };
    socketRate.set(socket.id, next);
    if (next.count > 12) return callback?.({ ok: false, error: 'rate_limited' });
    const parsed = sendSchema.safeParse(payload);
    if (!parsed.success) return callback?.({ ok: false, error: 'invalid_message' });
    const message = await saveMessage(roomDbId, claims.sub, socket.data.nickname ?? 'Misafir', socket.data.avatar, parsed.data.body);
    io.to(roomKey).emit('chat:message', message);
    callback?.({ ok: true, id: message.id });
  });
  socket.on('disconnect', async () => {
    socketRate.delete(socket.id);
    await leaveRoom(roomDbId, claims.sub);
    socket.to(roomKey).emit('room:leave', { userId: claims.sub });
  });
});

await app.listen({ port, host: '0.0.0.0' });
app.log.info(`gartic-online backend listening on ${port}`);
