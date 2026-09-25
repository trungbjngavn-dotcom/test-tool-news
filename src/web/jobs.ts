/**
 * Hàng đợi job một chỗ (render nặng, chạy song song sẽ tranh CPU/GPU).
 * Mỗi job phát log theo dòng; client theo dõi bằng Server-Sent Events.
 */

export type JobState = "queued" | "running" | "done" | "error";

export interface Job {
  id: string;
  kind: string;
  projectId: string;
  state: JobState;
  lines: string[];
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

type Listener = (job: Job, line?: string) => void;

const jobs = new Map<string, Job>();
const listeners = new Map<string, Set<Listener>>();
let queue: Promise<void> = Promise.resolve();
let counter = 0;

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function subscribe(jobId: string, fn: Listener): () => void {
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId)!.add(fn);
  return () => listeners.get(jobId)?.delete(fn);
}

function emit(job: Job, line?: string) {
  for (const fn of listeners.get(job.id) ?? []) {
    try {
      fn(job, line);
    } catch {
      /* client đã ngắt kết nối */
    }
  }
}

export interface JobHandle {
  log: (line: string) => void;
}

/**
 * Xếp một job vào hàng đợi. Trả về ngay để HTTP không bị treo;
 * client theo dõi qua /api/jobs/:id/stream.
 */
export function enqueue(
  kind: string,
  projectId: string,
  run: (h: JobHandle) => Promise<unknown>,
): Job {
  const id = `${kind}-${Date.now()}-${++counter}`;
  const job: Job = {
    id,
    kind,
    projectId,
    state: "queued",
    lines: [],
    startedAt: Date.now(),
  };
  jobs.set(id, job);

  const handle: JobHandle = {
    log(line) {
      job.lines.push(line);
      // giữ log gọn để không phình bộ nhớ khi render dài
      if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
      emit(job, line);
    },
  };

  queue = queue.then(async () => {
    job.state = "running";
    emit(job, "▶ bắt đầu");
    try {
      job.result = await run(handle);
      job.state = "done";
      emit(job, "✓ hoàn tất");
    } catch (e: any) {
      job.state = "error";
      job.error = String(e?.message ?? e);
      emit(job, `✗ lỗi: ${job.error}`);
    } finally {
      job.finishedAt = Date.now();
      emit(job);
    }
  });

  return job;
}
