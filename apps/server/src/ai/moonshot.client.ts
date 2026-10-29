import OpenAI from 'openai';

/** Same Moonshot OpenAI-compatible client ARC uses for Kimi. */
export const MOONSHOT_MODEL = 'kimi-k2.6';
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';

export function moonshotClient(): OpenAI {
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    throw new Error('MOONSHOT_API_KEY is not set.');
  }
  return new OpenAI({
    apiKey,
    baseURL: MOONSHOT_BASE_URL,
  });
}

export function configuredExtractionModel() {
  const model = process.env.AI_MODEL_EXTRACTION?.trim();
  if (!model || model === 'default') return MOONSHOT_MODEL;
  return model;
}

export function configuredClassificationModel() {
  const model = process.env.AI_MODEL_CLASSIFICATION?.trim();
  if (!model || model === 'default') return MOONSHOT_MODEL;
  return model;
}
