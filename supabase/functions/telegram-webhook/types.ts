export type EmojiToken = {
  value: string;
  id?: string;
};

export type EmojiConfig = {
  trophies: {
    platinum: EmojiToken;
    gold: EmojiToken;
    silver: EmojiToken;
    bronze: EmojiToken;
  };
  icons: {
    profile: EmojiToken;
    plus: EmojiToken;
    statusOnline: EmojiToken;
    statusOffline: EmojiToken;
    statusPlaying: EmojiToken;
  };
};

export type LinkedAccount = {
  chatId: number;
  userId: number;
  username: string | null;
  displayName: string;
  psnOnlineId: string;
  linkedAt: string;
};

export type LinkedUser = {
  chatId: number;
  userId: number;
  username: string | null;
  displayName: string;
  defaultPsnOnlineId: string | null;
};
