import { useCallback, useEffect } from 'react';
import { type BlockerFunction, useBlocker } from 'react-router-dom';

/**
 * Guards work that has been typed but not saved.
 *
 * Two different kinds of leaving have to be caught, and neither mechanism covers
 * the other. Moving to another screen inside the app is a router navigation, so
 * the router blocks it and we ask the question ourselves, in our own words.
 * Closing the tab, reloading, or following a link off the site never reaches the
 * router, so the browser's own `beforeunload` prompt is the only thing available;
 * its wording is fixed by the browser and cannot be styled or customised.
 *
 * Returning to the same screen is not leaving it, so a navigation that only
 * changes the query string or the hash is allowed through. Blocking those would
 * turn opening a tab or a filter into an interrogation.
 */
export interface UnsavedChanges {
  /** True while a navigation is being held, waiting for an answer. */
  blocked: boolean;
  /** Abandon the changes and continue to where the user was going. */
  discard: () => void;
  /** Stay where they are, changes intact. */
  keepEditing: () => void;
}

export function useUnsavedChanges(dirty: boolean): UnsavedChanges {
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        dirty && currentLocation.pathname !== nextLocation.pathname,
      [dirty],
    ),
  );

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Calling preventDefault is what asks for the prompt. Assigning to
      // returnValue as well is what older browsers look at.
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // A blocker left in the blocked state outlives the screen that created it and
  // would hold the next navigation hostage, so it is released once there is
  // nothing left to protect.
  useEffect(() => {
    if (!dirty && blocker.state === 'blocked') blocker.reset();
  }, [dirty, blocker]);

  return {
    blocked: blocker.state === 'blocked',
    discard: () => blocker.proceed?.(),
    keepEditing: () => blocker.reset?.(),
  };
}
