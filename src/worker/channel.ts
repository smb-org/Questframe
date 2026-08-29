import type { AppEnv } from "./env";

export const getChannelStub = (env: AppEnv): DurableObjectStub => {
  const id = env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`);
  return env.CHANNEL.get(id);
};
