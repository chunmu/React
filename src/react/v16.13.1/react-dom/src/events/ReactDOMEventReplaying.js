/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {AnyNativeEvent} from '../events/PluginModuleType';
import type {Container, SuspenseInstance} from '../client/ReactDOMHostConfig';
import type {DOMTopLevelEventType} from '../events/TopLevelEventTypes';
import type {ElementListenerMap} from '../client/ReactDOMComponentTree';
import type {EventSystemFlags} from './EventSystemFlags';
import type {FiberRoot} from 'react-reconciler/src/ReactInternalTypes';

import {
  enableDeprecatedFlareAPI,
  enableSelectiveHydration,
} from 'shared/ReactFeatureFlags';
import {
  unstable_runWithPriority as runWithPriority,
  unstable_scheduleCallback as scheduleCallback,
  unstable_NormalPriority as NormalPriority,
  unstable_getCurrentPriorityLevel as getCurrentPriorityLevel,
} from '../../../scheduler';
import {
  getNearestMountedFiber,
  getContainerFromFiber,
  getSuspenseInstanceFromFiber,
} from 'react-reconciler/src/ReactFiberTreeReflection';
import {attemptToDispatchEvent} from './ReactDOMEventListener';
import {
  getInstanceFromNode,
  getClosestInstanceFromNode,
  getEventListenerMap,
} from '../client/ReactDOMComponentTree';
import {unsafeCastDOMTopLevelTypeToString} from '../events/TopLevelEventTypes';
import {HostRoot, SuspenseComponent} from 'react-reconciler/src/ReactWorkTags';

let attemptSynchronousHydration: (fiber: Object) => void;

export function setAttemptSynchronousHydration(fn: (fiber: Object) => void) {
  attemptSynchronousHydration = fn;
}

let attemptUserBlockingHydration: (fiber: Object) => void;

export function setAttemptUserBlockingHydration(fn: (fiber: Object) => void) {
  attemptUserBlockingHydration = fn;
}

let attemptContinuousHydration: (fiber: Object) => void;

export function setAttemptContinuousHydration(fn: (fiber: Object) => void) {
  attemptContinuousHydration = fn;
}

let attemptHydrationAtCurrentPriority: (fiber: Object) => void;

export function setAttemptHydrationAtCurrentPriority(
  fn: (fiber: Object) => void,
) {
  attemptHydrationAtCurrentPriority = fn;
}

// TODO: Upgrade this definition once we're on a newer version of Flow that
// has this definition built-in.
type PointerEvent = Event & {
  pointerId: number,
  relatedTarget: EventTarget | null,
  ...
};

import {
  TOP_MOUSE_DOWN,
  TOP_MOUSE_UP,
  TOP_TOUCH_CANCEL,
  TOP_TOUCH_END,
  TOP_TOUCH_START,
  TOP_AUX_CLICK,
  TOP_DOUBLE_CLICK,
  TOP_POINTER_CANCEL,
  TOP_POINTER_DOWN,
  TOP_POINTER_UP,
  TOP_DRAG_END,
  TOP_DRAG_START,
  TOP_DROP,
  TOP_COMPOSITION_END,
  TOP_COMPOSITION_START,
  TOP_KEY_DOWN,
  TOP_KEY_PRESS,
  TOP_KEY_UP,
  TOP_INPUT,
  TOP_TEXT_INPUT,
  TOP_CLOSE,
  TOP_CANCEL,
  TOP_COPY,
  TOP_CUT,
  TOP_PASTE,
  TOP_CLICK,
  TOP_CHANGE,
  TOP_CONTEXT_MENU,
  TOP_RESET,
  TOP_SUBMIT,
  TOP_DRAG_ENTER,
  TOP_DRAG_LEAVE,
  TOP_MOUSE_OVER,
  TOP_MOUSE_OUT,
  TOP_POINTER_OVER,
  TOP_POINTER_OUT,
  TOP_GOT_POINTER_CAPTURE,
  TOP_LOST_POINTER_CAPTURE,
  TOP_FOCUS,
  TOP_BLUR,
} from './DOMTopLevelEventTypes';
import {IS_REPLAYED, PLUGIN_EVENT_SYSTEM} from './EventSystemFlags';
import {listenToTopLevelEvent} from './DOMModernPluginEventSystem';
import {addResponderEventSystemEvent} from './DeprecatedDOMEventResponderSystem';

type QueuedReplayableEvent = {|
  blockedOn: null | Container | SuspenseInstance,
  topLevelType: DOMTopLevelEventType,
  eventSystemFlags: EventSystemFlags,
  nativeEvent: AnyNativeEvent,
  targetContainers: Array<EventTarget>,
|};

let hasScheduledReplayAttempt = false;

// The queue of discrete events to be replayed.
const queuedDiscreteEvents: Array<QueuedReplayableEvent> = [];

// Indicates if any continuous event targets are non-null for early bailout.
const hasAnyQueuedContinuousEvents: boolean = false;
// The last of each continuous event type. We only need to replay the last one
// if the last target was dehydrated.
let queuedFocus: null | QueuedReplayableEvent = null;
let queuedDrag: null | QueuedReplayableEvent = null;
let queuedMouse: null | QueuedReplayableEvent = null;
// For pointer events there can be one latest event per pointerId.
const queuedPointers: Map<number, QueuedReplayableEvent> = new Map();
const queuedPointerCaptures: Map<number, QueuedReplayableEvent> = new Map();
// We could consider replaying selectionchange and touchmoves too.

type QueuedHydrationTarget = {|
  blockedOn: null | Container | SuspenseInstance,
  target: Node,
  priority: number,
|};
const queuedExplicitHydrationTargets: Array<QueuedHydrationTarget> = [];

export function hasQueuedDiscreteEvents(): boolean {
  return queuedDiscreteEvents.length > 0;
}

export function hasQueuedContinuousEvents(): boolean {
  return hasAnyQueuedContinuousEvents;
}

const discreteReplayableEvents = [
  TOP_MOUSE_DOWN,
  TOP_MOUSE_UP,
  TOP_TOUCH_CANCEL,
  TOP_TOUCH_END,
  TOP_TOUCH_START,
  TOP_AUX_CLICK,
  TOP_DOUBLE_CLICK,
  TOP_POINTER_CANCEL,
  TOP_POINTER_DOWN,
  TOP_POINTER_UP,
  TOP_DRAG_END,
  TOP_DRAG_START,
  TOP_DROP,
  TOP_COMPOSITION_END,
  TOP_COMPOSITION_START,
  TOP_KEY_DOWN,
  TOP_KEY_PRESS,
  TOP_KEY_UP,
  TOP_INPUT,
  TOP_TEXT_INPUT,
  TOP_CLOSE,
  TOP_CANCEL,
  TOP_COPY,
  TOP_CUT,
  TOP_PASTE,
  TOP_CLICK,
  TOP_CHANGE,
  TOP_CONTEXT_MENU,
  TOP_RESET,
  TOP_SUBMIT,
];

const continuousReplayableEvents = [
  TOP_FOCUS,
  TOP_BLUR,
  TOP_DRAG_ENTER,
  TOP_DRAG_LEAVE,
  TOP_MOUSE_OVER,
  TOP_MOUSE_OUT,
  TOP_POINTER_OVER,
  TOP_POINTER_OUT,
  TOP_GOT_POINTER_CAPTURE,
  TOP_LOST_POINTER_CAPTURE,
];

export function isReplayableDiscreteEvent(
  eventType: DOMTopLevelEventType,
): boolean {
  return discreteReplayableEvents.indexOf(eventType) > -1;
}

function trapReplayableEventForContainer(
  topLevelType: DOMTopLevelEventType,
  container: Container,
  listenerMap: ElementListenerMap,
) {
  listenToTopLevelEvent(
    topLevelType,
    ((container: any): Element),
    listenerMap,
    PLUGIN_EVENT_SYSTEM,
  );
}

function trapReplayableEventForDocument(
  topLevelType: DOMTopLevelEventType,
  document: Document,
  listenerMap: ElementListenerMap,
) {
  if (enableDeprecatedFlareAPI) {
    // Trap events for the responder system.
    const topLevelTypeString = unsafeCastDOMTopLevelTypeToString(topLevelType);
    // TODO: Ideally we shouldn't need these to be active but
    // if we only have a passive listener, we at least need it
    // to still pretend to be active so that Flare gets those
    // events.
    const activeEventKey = topLevelTypeString + '_active';
    if (!listenerMap.has(activeEventKey)) {
      const listener = addResponderEventSystemEvent(
        document,
        topLevelTypeString,
        false,
      );
      listenerMap.set(activeEventKey, {passive: false, listener});
    }
  }
}

export function eagerlyTrapReplayableEvents(
  container: Container,
  document: Document,
) {
  const listenerMapForDoc = getEventListenerMap(document);
  const listenerMapForContainer = getEventListenerMap(container);
  // Discrete
  discreteReplayableEvents.forEach(topLevelType => {
    trapReplayableEventForContainer(
      topLevelType,
      container,
      listenerMapForContainer,
    );
    trapReplayableEventForDocument(topLevelType, document, listenerMapForDoc);
  });
  // Continuous
  continuousReplayableEvents.forEach(topLevelType => {
    trapReplayableEventForContainer(
      topLevelType,
      container,
      listenerMapForContainer,
    );
    trapReplayableEventForDocument(topLevelType, document, listenerMapForDoc);
  });
}

function createQueuedReplayableEvent(
  blockedOn: null | Container | SuspenseInstance,
  topLevelType: DOMTopLevelEventType,
  eventSystemFlags: EventSystemFlags,
  targetContainer: EventTarget,
  nativeEvent: AnyNativeEvent,
): QueuedReplayableEvent {
  return {
    blockedOn,
    topLevelType,
    eventSystemFlags: eventSystemFlags | IS_REPLAYED,
    nativeEvent,
    targetContainers: [targetContainer],
  };
}

export function queueDiscreteEvent(
  blockedOn: null | Container | SuspenseInstance,
  topLevelType: DOMTopLevelEventType,
  eventSystemFlags: EventSystemFlags,
  targetContainer: EventTarget,
  nativeEvent: AnyNativeEvent,
): void {
  const queuedEvent = createQueuedReplayableEvent(
    blockedOn,
    topLevelType,
    eventSystemFlags,
    targetContainer,
    nativeEvent,
  );
  queuedDiscreteEvents.push(queuedEvent);
  if (enableSelectiveHydration) {
    if (queuedDiscreteEvents.length === 1) {
      // If this was the first discrete event, we might be able to
      // synchronously unblock it so that preventDefault still works.
      while (queuedEvent.blockedOn !== null) {
        const fiber = getInstanceFromNode(queuedEvent.blockedOn);
        if (fiber === null) {
          break;
        }
        attemptSynchronousHydration(fiber);
        if (queuedEvent.blockedOn === null) {
          // We got unblocked by hydration. Let's try again.
          replayUnblockedEvents();
          // If we're reblocked, on an inner boundary, we might need
          // to attempt hydrating that one.
          continue;
        } else {
          // We're still blocked from hydration, we have to give up
          // and replay later.
          break;
        }
      }
    }
  }
}

// Resets the replaying for this type of continuous event to no event.
export function clearIfContinuousEvent(
  topLevelType: DOMTopLevelEventType,
  nativeEvent: AnyNativeEvent,
): void {
  switch (topLevelType) {
    case TOP_FOCUS:
    case TOP_BLUR:
      queuedFocus = null;
      break;
    case TOP_DRAG_ENTER:
    case TOP_DRAG_LEAVE:
      queuedDrag = null;
      break;
    case TOP_MOUSE_OVER:
    case TOP_MOUSE_OUT:
      queuedMouse = null;
      break;
    case TOP_POINTER_OVER:
    case TOP_POINTER_OUT: {
      const pointerId = ((nativeEvent: any): PointerEvent).pointerId;
      queuedPointers.delete(pointerId);
      break;
    }
    case TOP_GOT_POINTER_CAPTURE:
    case TOP_LOST_POINTER_CAPTURE: {
      const pointerId = ((nativeEvent: any): PointerEvent).pointerId;
      queuedPointerCaptures.delete(pointerId);
      break;
    }
  }
}

function accumulateOrCreateContinuousQueuedReplayableEvent(
  existingQueuedEvent: null | QueuedReplayableEvent,
  blockedOn: null | Container | SuspenseInstance,
  topLevelType: DOMTopLevelEventType,
  eventSystemFlags: EventSystemFlags,
  targetContainer: EventTarget,
  nativeEvent: AnyNativeEvent,
): QueuedReplayableEvent {
  if (
    existingQueuedEvent === null ||
    existingQueuedEvent.nativeEvent !== nativeEvent
  ) {
    const queuedEvent = createQueuedReplayableEvent(
      blockedOn,
      topLevelType,
      eventSystemFlags,
      targetContainer,
      nativeEvent,
    );
    if (blockedOn !== null) {
      const fiber = getInstanceFromNode(blockedOn);
      if (fiber !== null) {
        // Attempt to increase the priority of this target.
        attemptContinuousHydration(fiber);
      }
    }
    return queuedEvent;
  }
  // If we have already queued this exact event, then it's because
  // the different event systems have different DOM event listeners.
  // We can accumulate the flags, and the targetContainers, and
  // store a single event to be replayed.
  existingQueuedEvent.eventSystemFlags |= eventSystemFlags;
  const targetContainers = existingQueuedEvent.targetContainers;
  if (
    targetContainer !== null &&
    targetContainers.indexOf(targetContainer) === -1
  ) {
    targetContainers.push(targetContainer);
  }
  return existingQueuedEvent;
}

export function queueIfContinuousEvent(
  blockedOn: null | Container | SuspenseInstance,
  topLevelType: DOMTopLevelEventType,
  eventSystemFlags: EventSystemFlags,
  targetContainer: EventTarget,
  nativeEvent: AnyNativeEvent,
): boolean {
  // These set relatedTarget to null because the replayed event will be treated as if we
  // moved from outside the window (no target) onto the target once it hydrates.
  // Instead of mutating we could clone the event.
  switch (topLevelType) {
    case TOP_FOCUS: {
      const focusEvent = ((nativeEvent: any): FocusEvent);
      queuedFocus = accumulateOrCreateContinuousQueuedReplayableEvent(
        queuedFocus,
        blockedOn,
        topLevelType,
        eventSystemFlags,
        targetContainer,
        focusEvent,
      );
      return true;
    }
    case TOP_DRAG_ENTER: {
      const dragEvent = ((nativeEvent: any): DragEvent);
      queuedDrag = accumulateOrCreateContinuousQueuedReplayableEvent(
        queuedDrag,
        blockedOn,
        topLevelType,
        eventSystemFlags,
        targetContainer,
        dragEvent,
      );
      return true;
    }
    case TOP_MOUSE_OVER: {
      const mouseEvent = ((nativeEvent: any): MouseEvent);
      queuedMouse = accumulateOrCreateContinuousQueuedReplayableEvent(
        queuedMouse,
        blockedOn,
        topLevelType,
        eventSystemFlags,
        targetContainer,
        mouseEvent,
      );
      return true;
    }
    case TOP_POINTER_OVER: {
      const pointerEvent = ((nativeEvent: any): PointerEvent);
      const pointerId = pointerEvent.pointerId;
      queuedPointers.set(
        pointerId,
        accumulateOrCreateContinuousQueuedReplayableEvent(
          queuedPointers.get(pointerId) || null,
          blockedOn,
          topLevelType,
          eventSystemFlags,
          targetContainer,
          pointerEvent,
        ),
      );
      return true;
    }
    case TOP_GOT_POINTER_CAPTURE: {
      const pointerEvent = ((nativeEvent: any): PointerEvent);
      const pointerId = pointerEvent.pointerId;
      queuedPointerCaptures.set(
        pointerId,
        accumulateOrCreateContinuousQueuedReplayableEvent(
          queuedPointerCaptures.get(pointerId) || null,
          blockedOn,
          topLevelType,
          eventSystemFlags,
          targetContainer,
          pointerEvent,
        ),
      );
      return true;
    }
  }
  return false;
}

// Check if this target is unblocked. Returns true if it's unblocked.
function attemptExplicitHydrationTarget(
  queuedTarget: QueuedHydrationTarget,
): void {
  // TODO: This function shares a lot of logic with attemptToDispatchEvent.
  // Try to unify them. It's a bit tricky since it would require two return
  // values.
  const targetInst = getClosestInstanceFromNode(queuedTarget.target);
  if (targetInst !== null) {
    const nearestMounted = getNearestMountedFiber(targetInst);
    if (nearestMounted !== null) {
      const tag = nearestMounted.tag;
      if (tag === SuspenseComponent) {
        const instance = getSuspenseInstanceFromFiber(nearestMounted);
        if (instance !== null) {
          // We're blocked on hydrating this boundary.
          // Increase its priority.
          queuedTarget.blockedOn = instance;
          runWithPriority(queuedTarget.priority, () => {
            attemptHydrationAtCurrentPriority(nearestMounted);
          });
          return;
        }
      } else if (tag === HostRoot) {
        const root: FiberRoot = nearestMounted.stateNode;
        if (root.hydrate) {
          queuedTarget.blockedOn = getContainerFromFiber(nearestMounted);
          // We don't currently have a way to increase the priority of
          // a root other than sync.
          return;
        }
      }
    }
  }
  queuedTarget.blockedOn = null;
}

export function queueExplicitHydrationTarget(target: Node): void {
  if (enableSelectiveHydration) {
    const priority = getCurrentPriorityLevel();
    const queuedTarget: QueuedHydrationTarget = {
      blockedOn: null,
      target: target,
      priority: priority,
    };
    let i = 0;
    for (; i < queuedExplicitHydrationTargets.length; i++) {
      if (priority <= queuedExplicitHydrationTargets[i].priority) {
        break;
      }
    }
    queuedExplicitHydrationTargets.splice(i, 0, queuedTarget);
    if (i === 0) {
      attemptExplicitHydrationTarget(queuedTarget);
    }
  }
}

function attemptReplayContinuousQueuedEvent(
  queuedEvent: QueuedReplayableEvent,
): boolean {
  if (queuedEvent.blockedOn !== null) {
    return false;
  }
  const targetContainers = queuedEvent.targetContainers;
  while (targetContainers.length > 0) {
    const targetContainer = targetContainers[0];
    const nextBlockedOn = attemptToDispatchEvent(
      queuedEvent.topLevelType,
      queuedEvent.eventSystemFlags,
      targetContainer,
      queuedEvent.nativeEvent,
    );
    if (nextBlockedOn !== null) {
      // We're still blocked. Try again later.
      const fiber = getInstanceFromNode(nextBlockedOn);
      if (fiber !== null) {
        attemptContinuousHydration(fiber);
      }
      queuedEvent.blockedOn = nextBlockedOn;
      return false;
    }
    // This target container was successfully dispatched. Try the next.
    targetContainers.shift();
  }
  return true;
}

function attemptReplayContinuousQueuedEventInMap(
  queuedEvent: QueuedReplayableEvent,
  key: number,
  map: Map<number, QueuedReplayableEvent>,
): void {
  if (attemptReplayContinuousQueuedEvent(queuedEvent)) {
    map.delete(key);
  }
}

function replayUnblockedEvents() {
  hasScheduledReplayAttempt = false;
  // First replay discrete events.
  while (queuedDiscreteEvents.length > 0) {
    const nextDiscreteEvent = queuedDiscreteEvents[0];
    if (nextDiscreteEvent.blockedOn !== null) {
      // We're still blocked.
      // Increase the priority of this boundary to unblock
      // the next discrete event.
      const fiber = getInstanceFromNode(nextDiscreteEvent.blockedOn);
      if (fiber !== null) {
        attemptUserBlockingHydration(fiber);
      }
      break;
    }
    const targetContainers = nextDiscreteEvent.targetContainers;
    while (targetContainers.length > 0) {
      const targetContainer = targetContainers[0];
      const nextBlockedOn = attemptToDispatchEvent(
        nextDiscreteEvent.topLevelType,
        nextDiscreteEvent.eventSystemFlags,
        targetContainer,
        nextDiscreteEvent.nativeEvent,
      );
      if (nextBlockedOn !== null) {
        // We're still blocked. Try again later.
        nextDiscreteEvent.blockedOn = nextBlockedOn;
        break;
      }
      // This target container was successfully dispatched. Try the next.
      targetContainers.shift();
    }
    if (nextDiscreteEvent.blockedOn === null) {
      // We've successfully replayed the first event. Let's try the next one.
      queuedDiscreteEvents.shift();
    }
  }
  // Next replay any continuous events.
  if (queuedFocus !== null && attemptReplayContinuousQueuedEvent(queuedFocus)) {
    queuedFocus = null;
  }
  if (queuedDrag !== null && attemptReplayContinuousQueuedEvent(queuedDrag)) {
    queuedDrag = null;
  }
  if (queuedMouse !== null && attemptReplayContinuousQueuedEvent(queuedMouse)) {
    queuedMouse = null;
  }
  queuedPointers.forEach(attemptReplayContinuousQueuedEventInMap);
  queuedPointerCaptures.forEach(attemptReplayContinuousQueuedEventInMap);
}

function scheduleCallbackIfUnblocked(
  queuedEvent: QueuedReplayableEvent,
  unblocked: Container | SuspenseInstance,
) {
  if (queuedEvent.blockedOn === unblocked) {
    queuedEvent.blockedOn = null;
    if (!hasScheduledReplayAttempt) {
      hasScheduledReplayAttempt = true;
      // Schedule a callback to attempt replaying as many events as are
      // now unblocked. This first might not actually be unblocked yet.
      // We could check it early to avoid scheduling an unnecessary callback.
      scheduleCallback(NormalPriority, replayUnblockedEvents);
    }
  }
}

export function retryIfBlockedOn(
  unblocked: Container | SuspenseInstance,
): void {
  // Mark anything that was blocked on this as no longer blocked
  // and eligible for a replay.
  if (queuedDiscreteEvents.length > 0) {
    scheduleCallbackIfUnblocked(queuedDiscreteEvents[0], unblocked);
    // This is a exponential search for each boundary that commits. I think it's
    // worth it because we expect very few discrete events to queue up and once
    // we are actually fully unblocked it will be fast to replay them.
    for (let i = 1; i < queuedDiscreteEvents.length; i++) {
      const queuedEvent = queuedDiscreteEvents[i];
      if (queuedEvent.blockedOn === unblocked) {
        queuedEvent.blockedOn = null;
      }
    }
  }

  if (queuedFocus !== null) {
    scheduleCallbackIfUnblocked(queuedFocus, unblocked);
  }
  if (queuedDrag !== null) {
    scheduleCallbackIfUnblocked(queuedDrag, unblocked);
  }
  if (queuedMouse !== null) {
    scheduleCallbackIfUnblocked(queuedMouse, unblocked);
  }
  const unblock = queuedEvent =>
    scheduleCallbackIfUnblocked(queuedEvent, unblocked);
  queuedPointers.forEach(unblock);
  queuedPointerCaptures.forEach(unblock);

  for (let i = 0; i < queuedExplicitHydrationTargets.length; i++) {
    const queuedTarget = queuedExplicitHydrationTargets[i];
    if (queuedTarget.blockedOn === unblocked) {
      queuedTarget.blockedOn = null;
    }
  }

  while (queuedExplicitHydrationTargets.length > 0) {
    const nextExplicitTarget = queuedExplicitHydrationTargets[0];
    if (nextExplicitTarget.blockedOn !== null) {
      // We're still blocked.
      break;
    } else {
      attemptExplicitHydrationTarget(nextExplicitTarget);
      if (nextExplicitTarget.blockedOn === null) {
        // We're unblocked.
        queuedExplicitHydrationTargets.shift();
      }
    }
  }
}
