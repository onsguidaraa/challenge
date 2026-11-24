/** Placeholder AI integration. No external model or data processing is performed. */
export const getStatus = () => ({
  available: false,
  message: 'AI features are not implemented yet.',
});

export const summarizeMaterial = () => ({
  available: false,
  summary: null,
  message: 'Material summarization is not implemented yet.',
});
