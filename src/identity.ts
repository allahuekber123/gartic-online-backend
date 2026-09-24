import { z } from 'zod';
import type { GarticIdentity } from './types.js';

const identitySchema = z.object({
  roomId: z.string().trim().min(1).max(120),
  userId: z.string().trim().min(1).max(120),
  userIndex: z.string().trim().max(120).optional(),
  nickname: z.string().trim().min(1).max(40),
  avatar: z.string().trim().max(500).optional(),
  source: z.enum(['cache', 'next-data', 'socket-join', 'url'])
});

export function parseIdentity(input: unknown) {
  return identitySchema.parse(input) as GarticIdentity;
}

export function sameIdentity(a: GarticIdentity, b: GarticIdentity) {
  return a.roomId === b.roomId && a.userId === b.userId && a.nickname === b.nickname;
}
