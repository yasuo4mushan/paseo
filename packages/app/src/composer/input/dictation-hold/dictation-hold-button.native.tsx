import { forwardRef, useCallback } from "react";
import { Pressable, View, type PressableProps } from "react-native";

import type { DictationHoldButtonProps } from "./types";

/**
 * Native fallback for the composer mic hold button. Pointer events do not fire
 * on native, so hold-to-talk maps onto Pressable press-in/press-out. There is
 * no slide-up cancel arm on native; releasing always confirms.
 */
export const DictationHoldButton = forwardRef<View, DictationHoldButtonProps & PressableProps>(
  function DictationHoldButton(
    { disabled, holdEnabled, onTap, onHoldStart, onHoldEnd, children, ...rest },
    ref,
  ) {
    const handlePressOut = useCallback(() => {
      onHoldEnd?.(false);
    }, [onHoldEnd]);

    if (!holdEnabled) {
      return (
        <Pressable ref={ref} disabled={disabled} onPress={disabled ? undefined : onTap} {...rest}>
          {children}
        </Pressable>
      );
    }
    return (
      <Pressable
        ref={ref}
        disabled={disabled}
        onPressIn={onHoldStart}
        onPressOut={handlePressOut}
        {...rest}
      >
        {children}
      </Pressable>
    );
  },
);
