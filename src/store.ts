import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ChatMessage, GarticIdentity } from './types.js';

const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined }) : null;
const memoryUsers = new Map<string, { id: string; nickname: string; avatar?: string }>();
const memoryMessages: ChatMessage[] = [];

export async function upsertIdentity(identity: GarticIdentity) {
  if (!pool) {
    const key = identity.userId || `guest:${identity.nickname}`;
    const existing = memoryUsers.get(key);
    if (existing) return existing;
    const user = { id: randomUUID(), nickname: identity.nickname.slice(0, 40), avatar: identity.avatar };
    memoryUsers.set(key, user);
    return user;
  }
  const result = await pool.query<{ id: string; nickname: string; avatar?: string }>(`INSERT INTO app_users (guest, nickname, gartic_id, gartic_index, avatar, last_seen_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (gartic_id) DO UPDATE SET nickname=EXCLUDED.nickname, avatar=EXCLUDED.avatar, last_seen_at=now() RETURNING id,nickname,avatar`, [identity.userId.startsWith('guest:') ? true : false, identity.nickname.slice(0, 40), identity.userId.startsWith('guest:') ? null : identity.userId, identity.userIndex ?? null, identity.avatar ?? null]);
  return result.rows[0]!;
}

export async function ensureRoom(roomId: string) {
  if (!pool) return roomId;
  const result = await pool.query<{ id: string }>(`INSERT INTO rooms (provider, external_room_id, last_seen_at) VALUES ('gartic.io',$1,now()) ON CONFLICT (provider, external_room_id) DO UPDATE SET last_seen_at=now() RETURNING id`, [roomId]);
  return result.rows[0]!.id;
}

export async function joinRoom(roomDbId: string, userId: string) {
  if (!pool) return;
  await pool.query(`INSERT INTO room_memberships (room_id,user_id,left_at) VALUES ($1,$2,NULL) ON CONFLICT (room_id,user_id) DO UPDATE SET left_at=NULL,joined_at=now()`, [roomDbId, userId]);
}

export async function leaveRoom(roomDbId: string, userId: string) {
  if (!pool) {
    for (let index = memoryMessages.length - 1; index >= 0; index -= 1) {
      if (memoryMessages[index]?.roomId === roomDbId) memoryMessages.splice(index, 1);
    }
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM rooms WHERE id=$1 FOR UPDATE`, [roomDbId]);
    await client.query(`UPDATE room_memberships SET left_at=now() WHERE room_id=$1 AND user_id=$2`, [roomDbId, userId]);
    const active = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM room_memberships WHERE room_id=$1 AND left_at IS NULL`, [roomDbId]);
    if (active.rows[0]?.count === '0') await client.query(`DELETE FROM messages WHERE room_id=$1`, [roomDbId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function saveMessage(roomDbId: string, userId: string, nickname: string, avatar: string | undefined, body: string): Promise<ChatMessage> {
  if (!pool) {
    const message: ChatMessage = { id: randomUUID(), roomId: roomDbId, senderId: userId, nickname, avatar, body, createdAt: new Date().toISOString() };
    memoryMessages.push(message);
    return message;
  }
  const result = await pool.query<{ id: string; created_at: Date }>(`INSERT INTO messages (room_id,sender_id,body) VALUES ($1,$2,$3) RETURNING id,created_at`, [roomDbId, userId, body]);
  return { id: result.rows[0]!.id, roomId: roomDbId, senderId: userId, nickname, avatar, body, createdAt: result.rows[0]!.created_at.toISOString() };
}

export async function listMessages(roomDbId: string, limit = 80): Promise<ChatMessage[]> {
  if (!pool) return memoryMessages.filter((message) => message.roomId === roomDbId).slice(-limit);
  const result = await pool.query<{ id: string; sender_id: string; body: string; created_at: Date; nickname: string; avatar?: string }>(
    `SELECT m.id,m.sender_id,m.body,m.created_at,u.nickname,u.avatar
       FROM messages m JOIN app_users u ON u.id=m.sender_id
      WHERE m.room_id=$1 ORDER BY m.created_at DESC LIMIT $2`,
    [roomDbId, limit],
  );
  return result.rows.reverse().map((row) => ({ id: row.id, roomId: roomDbId, senderId: row.sender_id, nickname: row.nickname, avatar: row.avatar, body: row.body, createdAt: row.created_at.toISOString() }));
}

export async function close() { await pool?.end(); }
