// Neutral "Z" mark for the built-in ZCode provider.
//
// This is an original, minimal glyph drawn for Paseo — it is NOT the official
// Z.ai / ZCode logo (that artwork is proprietary to Zhipu AI / Z.ai and is not
// redistributed here).
import Svg, { Path } from "react-native-svg";

interface ZcodeIconProps {
  size?: number;
  color?: string;
}

export function ZcodeIcon({ size = 16, color = "currentColor" }: ZcodeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill={color}>
      <Path d="M3 2.5h10v2.2L6.6 11.3H13v2.2H3v-2.2l6.4-6.6H3Z" fill={color} fillRule="evenodd" />
    </Svg>
  );
}
