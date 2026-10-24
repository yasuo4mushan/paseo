import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { View, type PointerEvent, type ViewProps } from "react-native";

import type { DictationHoldButtonProps } from "./types";

// How far up the pointer must travel from the press origin before releasing
// cancels the dictation instead of confirming it.
const CANCEL_SLIDE_THRESHOLD_PX = 72;
// A press shorter than this is a tap (toggle dictation); holding past it starts
// the hold-to-talk session. Doubao/WeChat style: tap toggles, hold talks.
const HOLD_START_DELAY_MS = 250;

interface GestureState {
  pointerId: number;
  startY: number;
  /** Set once the hold threshold elapses and onHoldStart has fired. */
  holdActive: boolean;
}

/**
 * Web press-and-hold surface for the composer mic button. Pointer events fire
 * only on web, so this implementation lives behind the .web extension; native
 * resolves dictation-hold-button to the Pressable fallback.
 *
 * A quick press fires onTap (the toggle-dictation behavior); pressing past
 * HOLD_START_DELAY_MS fires onHoldStart, and releasing then fires onHoldEnd —
 * with cancelled=true when the pointer slid up past CANCEL_SLIDE_THRESHOLD_PX.
 */
export const DictationHoldButton = forwardRef<View, DictationHoldButtonProps & ViewProps>(
  function DictationHoldButton(
    {
      disabled,
      holdEnabled,
      onTap,
      onHoldStart,
      onHoldEnd,
      onCancelArmedChange,
      children,
      ...rest
    },
    ref,
  ) {
    const gestureRef = useRef<GestureState | null>(null);
    const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [cancelArmed, setCancelArmed] = useState(false);
    const onHoldStartRef = useRef(onHoldStart);
    useEffect(() => {
      onHoldStartRef.current = onHoldStart;
    }, [onHoldStart]);

    const clearHoldTimer = useCallback(() => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    }, []);

    useEffect(() => clearHoldTimer, [clearHoldTimer]);

    const setArmed = useCallback(
      (armed: boolean) => {
        setCancelArmed((prev) => {
          if (prev === armed) return prev;
          onCancelArmedChange?.(armed);
          return armed;
        });
      },
      [onCancelArmedChange],
    );

    const releasePointerCapture = useCallback((event: PointerEvent, pointerId: number) => {
      try {
        const target = event.currentTarget as unknown as Element;
        target.releasePointerCapture?.(pointerId);
      } catch {
        // ignore
      }
    }, []);

    const handlePointerDown = useCallback(
      (event: PointerEvent) => {
        if (disabled || gestureRef.current) return;
        if (event.nativeEvent.pointerType === "mouse" && event.nativeEvent.button !== 0) return;

        if (!holdEnabled) {
          gestureRef.current = {
            pointerId: event.nativeEvent.pointerId,
            startY: event.nativeEvent.clientY,
            holdActive: false,
          };
          return;
        }

        event.preventDefault();
        const gesture: GestureState = {
          pointerId: event.nativeEvent.pointerId,
          startY: event.nativeEvent.clientY,
          holdActive: false,
        };
        gestureRef.current = gesture;
        try {
          const target = event.currentTarget as unknown as Element;
          target.setPointerCapture?.(event.nativeEvent.pointerId);
        } catch {
          // Capture is best-effort; pointerup on the same element is the common path.
        }

        clearHoldTimer();
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          if (gestureRef.current !== gesture) return;
          gesture.holdActive = true;
          onHoldStartRef.current?.();
        }, HOLD_START_DELAY_MS);
      },
      [clearHoldTimer, disabled, holdEnabled],
    );

    const handlePointerMove = useCallback(
      (event: PointerEvent) => {
        const gesture = gestureRef.current;
        if (!gesture?.holdActive || event.nativeEvent.pointerId !== gesture.pointerId) return;
        setArmed(event.nativeEvent.clientY - gesture.startY <= -CANCEL_SLIDE_THRESHOLD_PX);
      },
      [setArmed],
    );

    const handlePointerUp = useCallback(
      (event: PointerEvent) => {
        const gesture = gestureRef.current;
        if (!gesture || event.nativeEvent.pointerId !== gesture.pointerId) return;
        gestureRef.current = null;
        clearHoldTimer();

        if (gesture.holdActive) {
          releasePointerCapture(event, gesture.pointerId);
          const armed = cancelArmed;
          setArmed(false);
          onHoldEnd?.(armed);
          return;
        }
        if (!disabled) onTap?.();
      },
      [cancelArmed, clearHoldTimer, disabled, onHoldEnd, onTap, releasePointerCapture, setArmed],
    );

    const handlePointerCancel = useCallback(
      (event: PointerEvent) => {
        const gesture = gestureRef.current;
        if (!gesture || event.nativeEvent.pointerId !== gesture.pointerId) return;
        gestureRef.current = null;
        clearHoldTimer();

        if (gesture.holdActive) {
          releasePointerCapture(event, gesture.pointerId);
          setArmed(false);
          onHoldEnd?.(true);
        }
      },
      [clearHoldTimer, onHoldEnd, releasePointerCapture, setArmed],
    );

    return (
      <View
        ref={ref}
        accessibilityRole="button"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        {...rest}
      >
        {children}
      </View>
    );
  },
);
