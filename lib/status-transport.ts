import { runIgnoredCommand, type SpawnIgnoredFn } from "./commands.ts";

export function createStatusTransport(spawnIgnored: SpawnIgnoredFn) {
  let tail: Promise<void> = Promise.resolve();

  function send(message: Record<string, unknown>): Promise<boolean> {
    const delivery = tail.then(async () => {
      try {
        await runIgnoredCommand(spawnIgnored, "zellij", [
          "pipe", "--name", "pi_status", "--", JSON.stringify(message),
        ]);
        return true;
      } catch {
        return false;
      }
    });
    tail = delivery.then(() => undefined);
    return delivery;
  }

  return {
    send,
    drain: () => tail,
  };
}
