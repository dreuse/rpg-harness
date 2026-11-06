import type { DesignedManifest } from './designed-voices.ts';

export const DESIGNED_MANIFEST: DesignedManifest = {
  similarityModel: 'Wespeaker/wespeaker-voxceleb-resnet34-LM (ResNet34, 256-d embedding)',
  inputs: [
    {
      role: 'reference clips (human read speech)',
      source:
        'https://huggingface.co/datasets/google/fleurs/tree/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio',
      licence: 'CC-BY-4.0',
      attribution:
        'Google FLEURS pt_br, CC BY 4.0, anonymous read-speech volunteer. Conneau et al., FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech, arXiv:2205.12446',
    },
    {
      role: 'speaker similarity model',
      source: 'https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM',
      licence: 'CC-BY-4.0',
    },
    {
      role: 'Kokoro-82M ONNX model and base voice style vectors',
      source: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
      licence: 'Apache-2.0',
    },
  ],
  voices: [
    {
      id: 'pf_luiza',
      gender: 'female',
      ages: ['young'],
      timbre: ['warm', 'smooth'],
      licence: 'Apache-2.0',
      file: 'pf_luiza.bin',
      bytes: 522240,
      sha256: '952133dbe3eeb8a8e692d5090cb839c5e6597f57f90d6c65a67232cccd7a32a5',
      references: [
        {
          file: 'train/10037811280993524975.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/train.tar.gz#train/10037811280993524975.wav',
        },
      ],
      weights: {
        af_sarah: 0.4,
        pf_dora: 0.6,
      },
      seed: 1,
      similarity: {
        score: 0.2377,
        searchScore: 0.2633,
        baselineVoice: 'af_sarah',
        baselineScore: 0.0498,
        otherTargetsMax: 0.2182,
      },
    },
    {
      id: 'pf_beatriz',
      gender: 'female',
      ages: ['adult'],
      timbre: ['warm', 'smooth'],
      licence: 'Apache-2.0',
      file: 'pf_beatriz.bin',
      bytes: 522240,
      sha256: '52734c275fe5eee661baae62d50fc52e90c81b62e156579b32f2ff0dde1983dd',
      references: [
        {
          file: 'train/11084584502097351417.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/train.tar.gz#train/11084584502097351417.wav',
        },
      ],
      weights: {
        af_sarah: 0.15,
        bf_emma: 0.4,
        pf_dora: 0.45,
      },
      seed: 2,
      similarity: {
        score: 0.3074,
        searchScore: 0.3032,
        baselineVoice: 'bf_emma',
        baselineScore: 0.1461,
        otherTargetsMax: 0.1833,
      },
    },
    {
      id: 'pm_davi',
      gender: 'male',
      ages: ['young'],
      timbre: ['crisp', 'bright'],
      licence: 'Apache-2.0',
      file: 'pm_davi.bin',
      bytes: 522240,
      sha256: '7b88a8b7a495ec32fc61eb467e15cc2f521b31e6d2d979ec7a97bc076f058e2f',
      references: [
        {
          file: 'dev/10281411371095075004.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10281411371095075004.wav',
        },
        {
          file: 'dev/10469354627012887368.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10469354627012887368.wav',
        },
        {
          file: 'dev/10484400070252823650.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10484400070252823650.wav',
        },
        {
          file: 'dev/10772221179495683943.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10772221179495683943.wav',
        },
        {
          file: 'dev/1088555081702852536.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/1088555081702852536.wav',
        },
        {
          file: 'dev/11193159258989471636.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/11193159258989471636.wav',
        },
        {
          file: 'dev/11278916061079989542.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/11278916061079989542.wav',
        },
        {
          file: 'dev/11296799965122436324.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/11296799965122436324.wav',
        },
      ],
      weights: {
        am_onyx: 0.05,
        pm_alex: 0.95,
      },
      seed: 3,
      similarity: {
        score: 0.3052,
        searchScore: 0.3361,
        baselineVoice: 'pm_alex',
        baselineScore: 0.0664,
        otherTargetsMax: 0.1781,
      },
    },
    {
      id: 'pm_henrique',
      gender: 'male',
      ages: ['adult'],
      timbre: ['light', 'bright'],
      licence: 'Apache-2.0',
      file: 'pm_henrique.bin',
      bytes: 522240,
      sha256: '8465102a32e78654039d07c42c3efa1c5a06ed9c6cf8b09030f41b191fbca795',
      references: [
        {
          file: 'dev/10114312680249610589.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10114312680249610589.wav',
        },
        {
          file: 'dev/10165966771567591302.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10165966771567591302.wav',
        },
        {
          file: 'dev/10181533133173393073.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10181533133173393073.wav',
        },
        {
          file: 'dev/10214311447059175309.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10214311447059175309.wav',
        },
        {
          file: 'dev/10221738448089878097.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10221738448089878097.wav',
        },
        {
          file: 'dev/10275176137959631739.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10275176137959631739.wav',
        },
        {
          file: 'dev/10288689224088672788.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/10288689224088672788.wav',
        },
        {
          file: 'dev/1028956226170549330.wav',
          url: 'https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/pt_br/audio/dev.tar.gz#dev/1028956226170549330.wav',
        },
      ],
      weights: {
        am_liam: 0.8,
        pm_alex: 0.1,
        pm_santa: 0.1,
      },
      seed: 4,
      similarity: {
        score: 0.2656,
        searchScore: 0.3089,
        baselineVoice: 'am_liam',
        baselineScore: 0.1999,
        otherTargetsMax: 0.1061,
      },
    },
  ],
};
