// Ends every process of the user id it runs as (workers.ts "endProcessesOf",
// specs/app/hosted-app.feature.md "Stopping a worker ends everything it
// started"). The gateway starts it as one person's uid, through setpriv, so
// the kernel itself limits what it reaches to that person's processes: a
// signal to "every process" (pid -1) goes to the ones the caller may signal,
// and never to the caller.
//
// It refuses to run as anything but a worker uid. Run by hand as an ordinary
// user it would end that user's whole session.

/** Worker uids count up from here (accounts.ts OS_UID_BASE). */
const WORKER_UID_BASE = 200_000;

/** Whether `uid` is a worker's: the only kind this may run as. */
export function isWorkerUid(uid: number | undefined): boolean {
  return uid !== undefined && Number.isInteger(uid) && uid >= WORKER_UID_BASE;
}

// Only as the program itself: importing this file ends nothing.
if (import.meta.main) {
  const uid = process.getuid?.();
  if (!isWorkerUid(uid)) {
    console.error(`endProcesses runs only as a worker uid (${WORKER_UID_BASE} and up), not as ${uid}`);
    process.exit(2);
  }
  try {
    process.kill(-1, "SIGKILL");
  } catch {
    // ESRCH: nothing else runs as this uid.
  }
}
