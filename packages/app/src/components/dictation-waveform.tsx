import { useEffect, useMemo } from "react";
import { View } from "react-native";
import ReanimatedAnimated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  type SharedValue,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";

const BAR_COUNT = 9;
const BAR_WIDTH = 4;
const BAR_GAP = 5;
// Mirrored gains so the cluster reads as a waveform centered on the middle bar.
const BAR_GAINS = [0.4, 0.62, 0.85, 1, 0.74, 1, 0.85, 0.62, 0.4] as const;
const MIN_BAR_HEIGHT = 5;
const MAX_BAR_HEIGHT = 26;
const IDLE_PULSE_MIN = 0.16;

interface DictationWaveformProps {
  /** Normalized 0..1 loudness from the dictation audio source. */
  volume: number;
  color: string;
}

function withIdlePulse(shared: SharedValue<number>): void {
  shared.value = withRepeat(
    withSequence(
      withTiming(IDLE_PULSE_MIN, { duration: 650, easing: Easing.inOut(Easing.ease) }),
      withTiming(0.02, { duration: 650, easing: Easing.inOut(Easing.ease) }),
    ),
    -1,
    false,
  );
}

/**
 * Loudness bars for the dictation overlay. One shared value carries the volume
 * so every bar derives its height on the UI thread (same pattern as VolumeMeter,
 * with more bars for the wide waveform look).
 */
export function DictationWaveform({ volume, color }: DictationWaveformProps) {
  const animatedVolume = useSharedValue(0);

  useEffect(() => {
    if (volume > 0.005) {
      animatedVolume.value = withTiming(volume, {
        duration: volume > animatedVolume.value ? 70 : 140,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      withIdlePulse(animatedVolume);
    }
  }, [animatedVolume, volume]);

  const bars = useMemo(
    () =>
      Array.from({ length: BAR_COUNT }, (_unused, index) => {
        const gain = BAR_GAINS[index];
        const style = () => {
          "worklet";
          const level = animatedVolume.value * gain;
          return {
            height: MIN_BAR_HEIGHT + (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT) * Math.min(1, level),
          };
        };
        // Each bar closes over its own style callback; useAnimatedStyle must be
        // called unconditionally per bar, so it lives inside this map through a
        // child component instead (see WaveformBar below).
        return { gain, key: `bar-${index}`, style };
      }),
    [animatedVolume],
  );

  return (
    <View style={styles.container} pointerEvents="none">
      {bars.map((bar) => (
        <WaveformBar key={bar.key} buildStyle={bar.style} color={color} />
      ))}
    </View>
  );
}

function WaveformBar({
  buildStyle,
  color,
}: {
  buildStyle: () => { height: number };
  color: string;
}) {
  const animatedStyle = useAnimatedStyle(buildStyle);
  return (
    <ReanimatedAnimated.View style={[styles.bar, { backgroundColor: color }, animatedStyle]} />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: BAR_GAP,
    height: MAX_BAR_HEIGHT,
    minWidth: BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP,
  },
  bar: {
    width: BAR_WIDTH,
    borderRadius: theme.borderRadius.full,
  },
}));
