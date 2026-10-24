import { existsSync } from "node:fs";
import type pino from "pino";

import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

export interface SherpaOfflineNemoTransducerModel {
  kind: "nemo_transducer";
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

export interface SherpaOfflineSenseVoiceModel {
  kind: "sense_voice";
  model: string;
  tokens: string;
  language?: "auto" | "zh" | "en" | "ja" | "ko" | "yue";
  useInverseTextNormalization?: boolean;
}

export type SherpaOfflineRecognizerModel =
  | SherpaOfflineNemoTransducerModel
  | SherpaOfflineSenseVoiceModel;

export interface SherpaOfflineRecognizerConfig {
  model: SherpaOfflineRecognizerModel;
  numThreads?: number;
  provider?: "cpu";
  debug?: 0 | 1;
  sampleRate?: number;
  featureDim?: number;
  decodingMethod?: "greedy_search";
  maxActivePaths?: number;
}

interface SherpaOfflineRecognizerNative {
  config?: { featConfig?: { sampleRate?: number } };
  createStream: () => unknown;
  decode: (stream: unknown) => void;
  getResult: (stream: unknown) => { text?: string } | string | undefined;
  free?: () => void;
}

interface SherpaOfflineStreamNative {
  acceptWaveform: ((arg: { samples: Float32Array; sampleRate: number }) => void) &
    ((sampleRate: number, samples: Float32Array) => void);
  free?: () => void;
}

function assertModelFilesPresent(model: SherpaOfflineRecognizerModel): void {
  if (model.kind === "sense_voice") {
    assertFileExists(model.model, "sense voice model");
    assertFileExists(model.tokens, "tokens");
    return;
  }
  assertFileExists(model.encoder, "offline encoder");
  assertFileExists(model.decoder, "offline decoder");
  assertFileExists(model.joiner, "offline joiner");
  assertFileExists(model.tokens, "tokens");
}

function buildRecognizerConfig(config: SherpaOfflineRecognizerConfig): {
  featConfig: { sampleRate: number; featureDim: number };
  modelConfig: Record<string, unknown>;
  decodingMethod: "greedy_search";
  maxActivePaths?: number;
} {
  const commonModelConfig = {
    tokens: config.model.tokens,
    numThreads: config.numThreads ?? 1,
    provider: config.provider ?? "cpu",
    debug: config.debug ?? 0,
  };
  const featConfig = {
    sampleRate: config.sampleRate ?? 16000,
    featureDim: config.featureDim ?? 80,
  };

  if (config.model.kind === "sense_voice") {
    return {
      featConfig,
      modelConfig: {
        ...commonModelConfig,
        senseVoice: {
          model: config.model.model,
          language: config.model.language ?? "auto",
          useInverseTextNormalization: config.model.useInverseTextNormalization ?? true,
        },
        modelType: "sense_voice",
      },
      decodingMethod: config.decodingMethod ?? "greedy_search",
    };
  }

  return {
    featConfig,
    modelConfig: {
      ...commonModelConfig,
      transducer: {
        encoder: config.model.encoder,
        decoder: config.model.decoder,
        joiner: config.model.joiner,
      },
      modelType: "nemo_transducer",
    },
    decodingMethod: config.decodingMethod ?? "greedy_search",
    maxActivePaths: config.maxActivePaths ?? 4,
  };
}

export class SherpaOfflineRecognizerEngine {
  public readonly recognizer: SherpaOfflineRecognizerNative;
  public readonly sampleRate: number;
  private readonly logger: pino.Logger;

  constructor(config: SherpaOfflineRecognizerConfig, logger: pino.Logger) {
    this.logger = logger.child({
      module: "speech",
      provider: "local",
      component: "offline-recognizer",
    });

    assertModelFilesPresent(config.model);

    const sherpa = loadSherpaOnnxNode();
    const recognizerConfig = buildRecognizerConfig(config);

    this.recognizer = new (
      sherpa as unknown as {
        OfflineRecognizer: new (config: unknown) => SherpaOfflineRecognizerNative;
      }
    ).OfflineRecognizer(recognizerConfig);
    const sr = this.recognizer?.config?.featConfig?.sampleRate;
    this.sampleRate =
      typeof sr === "number" && Number.isFinite(sr) && sr > 0
        ? sr
        : recognizerConfig.featConfig.sampleRate;

    this.logger.info(
      {
        engine: config.model.kind,
        sampleRate: this.sampleRate,
        numThreads: recognizerConfig.modelConfig.numThreads,
      },
      "Sherpa offline recognizer initialized",
    );
  }

  createStream(): SherpaOfflineStreamNative {
    return this.recognizer.createStream() as SherpaOfflineStreamNative;
  }

  acceptWaveform(
    stream: SherpaOfflineStreamNative,
    sampleRate: number,
    samples: Float32Array,
  ): void {
    if (!stream || typeof stream.acceptWaveform !== "function") {
      throw new Error("Unexpected sherpa offline stream: missing acceptWaveform()");
    }

    // sherpa-onnx-node expects: acceptWaveform({ samples, sampleRate })
    // sherpa-onnx (WASM) expects: acceptWaveform(sampleRate, samples)
    if (stream.acceptWaveform.length <= 1) {
      stream.acceptWaveform({ samples, sampleRate });
    } else {
      stream.acceptWaveform(sampleRate, samples);
    }
  }

  free(): void {
    try {
      this.recognizer?.free?.();
    } catch (err) {
      this.logger.warn({ err }, "Failed to free sherpa offline recognizer");
    }
  }
}
