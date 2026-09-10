import {
  MAX_EXTRAPOLATION_MS,
  RENDER_DELAY_MAX_MS,
  RENDER_DELAY_MIN_MS,
  SAMPLE_BUFFER_SIZE,
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

  observe(serverAt: number, arrivalAt: number): void {
    if (this.lastServerAt > 0) {
      const interval = serverAt - this.lastServerAt;
      if (interval > 0) {
        const jitter = Math.abs((arrivalAt - this.lastArrivalAt) - interval);
        this.delayMs = Math.max(RENDER_DELAY_MIN_MS, Math.min(RENDER_DELAY_MAX_MS, interval * 1.5 + jitter * 1.5));
      }
    }
    this.lastServerAt = serverAt;
    this.lastArrivalAt = arrivalAt;
  }

  private lastArrivalAt = 0;

  get renderAt(): number {
    return Date.now() - this.delayMs;
  }

  get delay(): number {
    return Math.round(this.delayMs);
  }
}
