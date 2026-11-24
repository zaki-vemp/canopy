import React from 'react';
import {
  StyleSheet,
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputProps,
  type TextProps,
  type TextStyle,
} from 'react-native';

// Every screen imports Text and TextInput from here so the Pieces fonts land
// everywhere without each style naming a family. A style that already names a
// family (the mono codes) keeps it; otherwise a heavy or large run is Gabarito
// and the rest is Figtree.
function resolve(style: TextStyle): TextStyle {
  const { fontWeight, ...rest } = style;
  const fam = style.fontFamily;
  if (fam === 'monospace' || fam === 'Menlo') return { ...rest, fontFamily: 'DMMono_500Medium' };
  if (fam && fam.includes('_')) return rest;
  const w = String(fontWeight ?? '400');
  const heavy = w === '700' || w === '800' || w === '900' || w === 'bold';
  const mid = w === '600' || w === '500';
  if ((style.fontSize ?? 14) >= 17) {
    return { ...rest, fontFamily: heavy ? 'Gabarito_600SemiBold' : mid ? 'Gabarito_500Medium' : 'Gabarito_400Regular' };
  }
  return { ...rest, fontFamily: heavy ? 'Figtree_700Bold' : w === '600' ? 'Figtree_600SemiBold' : w === '500' ? 'Figtree_500Medium' : 'Figtree_400Regular' };
}

export const Text = React.forwardRef<RNText, TextProps>(function Text(props, ref) {
  const flat = StyleSheet.flatten(props.style) as TextStyle | undefined;
  return <RNText ref={ref} {...props} style={resolve(flat ?? {})} />;
});

export const TextInput = React.forwardRef<RNTextInput, TextInputProps>(function TextInput(
  props,
  ref
) {
  const flat = StyleSheet.flatten(props.style) as TextStyle | undefined;
  return <RNTextInput ref={ref} {...props} style={resolve(flat ?? {})} />;
});
