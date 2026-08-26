import { fileURLToPath, URL } from 'node:url';

/**
 * Where the API lives, for the two places that have to run it.
 *
 * The Playwright configuration starts the server from here, and one spec runs a
 * script from the same interpreter to read a supplier's email. Shared rather
 * than written twice, because a suite that started one Python and shelled out to
 * another would work on every machine where the two happen to match and fail
 * confusingly on the first where they do not.
 */

export const API_DIR = fileURLToPath(new URL('../../../api', import.meta.url));

/**
 * An absolute path to the API's own interpreter, so this works on a machine
 * where `uv` is not on PATH and without depending on the shell's idea of a
 * relative executable. Overridable because CI installs the API into the system
 * Python and has no virtual environment to point at.
 */
export const API_PYTHON =
  process.env.FINORA_API_PYTHON ??
  fileURLToPath(
    new URL(
      process.platform === 'win32'
        ? '../../../api/.venv/Scripts/python.exe'
        : '../../../api/.venv/bin/python',
      import.meta.url,
    ),
  );

/** The database the visual suite builds and is allowed to destroy. */
export const VISUAL_DB = 'finora_visual';
