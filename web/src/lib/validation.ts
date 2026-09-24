/** Client-side checks for the Create form. The server re-validates everything. */
import { LIMITS, type GenerationSettings } from '@shared/api';
import { isValidLanguageTag } from './options';

export interface CreateFormIssues {
  script?: string;
  image?: string;
  language?: string;
  extraDirections?: string;
}

export function validateCreateForm(input: {
  script: string;
  settings: GenerationSettings;
  hasImage: boolean;
}): CreateFormIssues {
  const issues: CreateFormIssues = {};
  const script = input.script.trim();
  if (script.length < LIMITS.scriptMinChars) {
    issues.script = `Write a script of at least ${LIMITS.scriptMinChars} characters.`;
  } else if (script.length > LIMITS.scriptMaxChars) {
    issues.script = `The script is limited to ${LIMITS.scriptMaxChars} characters.`;
  }
  if (!input.hasImage) issues.image = 'Add a character image.';
  if (!input.settings.language.trim()) {
    issues.language = 'Choose the spoken language.';
  } else if (!isValidLanguageTag(input.settings.language)) {
    issues.language = 'Use a language code such as en, fr or pt-BR.';
  }
  if (input.settings.extraDirections.length > LIMITS.extraDirectionsMaxChars) {
    issues.extraDirections = `Extra directions are limited to ${LIMITS.extraDirectionsMaxChars} characters.`;
  }
  return issues;
}

export function issueList(issues: CreateFormIssues): string[] {
  return Object.values(issues).filter((value): value is string => typeof value === 'string');
}
