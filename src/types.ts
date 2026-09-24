export type GarticIdentity = {
  source: 'cache' | 'next-data' | 'socket-join' | 'url';
  roomId: string;
  userId: string;
  userIndex?: string;
  nickname: string;
  avatar?: string;
};

export type SessionClaims = {
  sub: string;
  roomId: string;
  provider: 'gartic.io';
  identityHash: string;
  nickname: string;
  avatar?: string;
  iat: number;
  exp: number;
  nonce: string;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  senderId: string;
  nickname: string;
  avatar?: string;
  body: string;
  createdAt: string;
};
