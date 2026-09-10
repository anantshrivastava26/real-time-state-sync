import {
  MAX_EXTRAPOLATION_MS,
  RENDER_DELAY_MAX_MS,
  RENDER_DELAY_MIN_MS,
  SAMPLE_BUFFER_SIZE,
  TICK_MS,
} from "../../shared/config";

export interface PositionSample {
  at: number;
  x: number;
  y: number;
}

export class RemoteCursor {
  private readonly samples: PositionSample[] = [];

  push(sample: PositionSample): void {
    const last = this.samples[this.samples.length - 1];
    if (last && sample.at <= last.at) return;
    this.samples.push(sample);
    while (this.samples.length > SAMPLE_BUFFER_SIZE) this.samples.shift();
  }

  get empty(): boolean {
    return this.samples.length === 0;
  }

  sample(renderAt: number): { x: number; y: number } | null {
    if (this.samples.length === 0) return null;
    if (this.samples.length === 1) {
      const only = this.samples[0] as PositionSample;
      return { x: only.x, y: only.y };
    }

    let before = this.samples[0] as PositionSample;
    let after = this.samples[1] as PositionSample;
    for (let index = 1; index < this.samples.length; index++) {
      const candidate = this.samples[index] as PositionSample;
      if (candidate.at >= renderAt) {
        after = candidate;
        before = this.samples[index - 1] as PositionSample;
        const span = Math.max(1, after.at - before.at);
        const progress = Math.max(0, Math.min(1, (renderAt - before.at) / span));
        return {
          x: before.x + (after.x - before.x) * progress,
          y: before.y + (after.y - before.y) * progress,
        };
      }
      before = candidate;
    }

    const previous = this.samples[this.samples.length - 2] as PositionSample;
    const latest = this.samples[this.samples.length - 1] as PositionSample;
    const elapsed = renderAt - latest.at;
    if (elapsed <= MAX_EXTRAPOLATION_MS) {
      const span = Math.max(1, latest.at - previous.at);
      const amount = elapsed / span;
      return {
        x: Math.max(0, Math.min(1, latest.x + (latest.x - previous.x) * amount)),
        y: Math.max(0, Math.min(1, latest.y + (latest.y - previous.y) * amount)),
      };
    }
    return { x: latest.x, y: latest.y };
  }
}

export class RenderClock {
  private delayMs = RENDER_DELAY_MIN_MS;
  private lastServerAt = 0;
  private lastArrivalAt = 0;
  private intervalEma = TICK_MS;
  private jitterEma = 0;

  /**
   * Target delay is derived from smoothed interval/jitter estimates (EMA,
   * not the raw per-tick sample) and `delayMs` eases toward that target
   * rather than snapping to it. A single noisy arrival would otherwise move
   * `renderAt` abruptly, which reads as the remote cursor jumping instead of
   * gliding.
   */
  observe(serverAt: number, arrivalAt: number): void {
    if (this.lastServerAt > 0) {
      const interval = serverAt - this.lastServerAt;
      if (interval > 0) {
        const arrivalInterval = arrivalAt - this.lastArrivalAt;
        const deviation = Math.abs(arrivalInterval - interval);
        this.intervalEma += (interval - this.intervalEma) / 8;
        this.jitterEma += (deviation - this.jitterEma) / 8;
        const target = Math.max(
          RENDER_DELAY_MIN_MS,
          Math.min(RENDER_DELAY_MAX_MS, this.intervalEma * 1.5 + this.jitterEma * 1.5),
        );
        this.delayMs += (target - this.delayMs) / 4;
      }
    }
    this.lastServerAt = serverAt;
    this.lastArrivalAt = arrivalAt;
  }

  get renderAt(): number {
    return Date.now() - this.delayMs;
  }

  get delay(): number {
    return Math.round(this.delayMs);
  }
}
