/**
 * AudioWorklet: DJ key lock. Undoes the pitch change of a deck playing at a matched tempo with preservesPitch off
 * (see djWsola.ts). Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — public/js/audio/worklets.js.
 * Loaded with audioWorklet.addModule(); bundled on its own by Vite (`?worker&url`).
 */
import { KeyLockShifter } from './djWsola';

// Minimal AudioWorkletGlobalScope typings (not in lib.dom).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

class KeyLockProcessor extends AudioWorkletProcessor {
  private shifter = new KeyLockShifter(2, Math.max(16384, Math.ceil(sampleRate / 2)));

  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }];
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const out = outputs[0];
    if (!out?.length) return true;
    this.shifter.pitch = params.pitch?.[0] ?? 1;
    this.shifter.process(inputs[0] ?? [], out);
    return true;
  }
}

registerProcessor('mediamax-keylock', KeyLockProcessor);
