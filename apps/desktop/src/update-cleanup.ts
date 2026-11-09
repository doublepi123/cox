export async function closeDesktopUpdates(
  managers: readonly ({ close(): Promise<void> } | undefined)[],
  report: (error: unknown) => void,
) {
  await Promise.all(
    managers.map(async (manager) => {
      try {
        await manager?.close();
      } catch (error) {
        report(error);
      }
    }),
  );
}
