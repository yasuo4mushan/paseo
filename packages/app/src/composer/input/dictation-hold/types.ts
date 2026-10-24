import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

export interface DictationHoldButtonProps {
  /** Blocks the gesture entirely; the button renders but ignores presses. */
  disabled?: boolean;
  /**
   * When true, press-and-hold drives dictation: press starts, release finishes.
   * When false, the button behaves as a plain tap button and fires onTap.
   */
  holdEnabled: boolean;
  onTap?: () => void;
  onHoldStart?: () => void;
  /** cancelled=true when the gesture ended as a cancel (slide-up armed on web). */
  onHoldEnd?: (cancelled: boolean) => void;
  /** Web only: the slide-up cancel zone armed or disarmed. Native never arms. */
  onCancelArmedChange?: (armed: boolean) => void;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}
