import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemedText } from '@/components/themed-text';
import { SIGNAL_COLOR_OPTIONS, signalColorInk } from '@/constants/signal-colors';
import { CryptidThemes, Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { GeneratedCryptid } from '../core/cryptid-generator';
import {
  createCryptidProfile,
  DEFAULT_SIGNAL_COLOR,
  findCryptidPreset,
  handleInputValue,
  MAX_SIGIL_COLUMNS,
  MAX_SIGIL_LINES,
  normalizeAsciiArt,
  profileToDraft,
  sigilMeasurements,
  USERNAME_GUIDANCE,
  validateCryptidProfileFields,
  type CryptidProfile,
  type CryptidProfileDraft,
} from '../core/profile';
import { randomPersona, type RandomPersona } from '../core/random-persona';
import { CryptidAvatar } from './cryptid-avatar';
import { CryptidGeneratorDialog } from './cryptid-generator-dialog';

// Defer Skia at boot; the web loader also gates first-run use on CanvasKit,
// because onboarding can open this picker before the map initializes it.
const SignalColorPicker = lazy(() =>
  import('./signal-color-picker-loader').then((m) => ({ default: m.SignalColorPicker }))
);

const PROFILE_MAX_WIDTH = 640;

type ActiveEditor = 'icon' | 'signal' | null;

interface CryptidProfileEditorProps {
  mode: 'onboarding' | 'edit';
  initialProfile?: CryptidProfile | null;
  notice?: string | null;
  onSave(profile: CryptidProfile): Promise<void>;
  onDone?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The three fields a roll of the dice replaces, together. */
type PersonaFields = RandomPersona;

/**
 * First run starts on a rolled persona rather than an empty form: the point of the
 * randomizer is that you are handed an identity, so the very first thing you see
 * is one. Older profiles that stored a `presetId` are unpacked into the same
 * editable fields, since the preset grid they came from is gone.
 */
function startingDraft(profile: CryptidProfile | null | undefined): CryptidProfileDraft {
  if (!profile) return { handle: '', presetId: null, ...randomPersona() };
  const draft = { ...profileToDraft(profile), handle: handleInputValue(profile.handle) };
  const preset = findCryptidPreset(draft.presetId);
  if (!preset) return draft;
  return { ...draft, cryptidName: preset.name, sigil: preset.art, presetId: null };
}

export function CryptidProfileEditor({
  mode,
  initialProfile,
  notice,
  onSave,
  onDone,
}: CryptidProfileEditorProps) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const insets = useSafeAreaInsets();
  const [initialDraft] = useState<CryptidProfileDraft>(() => startingDraft(initialProfile));
  const initialColor = initialDraft.color || DEFAULT_SIGNAL_COLOR;

  const [savedDraft, setSavedDraft] = useState(initialDraft);
  const [handle, setHandle] = useState(initialDraft.handle);
  const [cryptidName, setCryptidName] = useState(initialDraft.cryptidName);
  const [sigil, setSigil] = useState(initialDraft.sigil);
  const [color, setColor] = useState(initialColor);
  // Nothing opens by default: username is always visible now, and onboarding used
  // to open it here.
  const [activeEditor, setActiveEditor] = useState<ActiveEditor>(null);
  const [handleTouched, setHandleTouched] = useState(false);
  const [customNameTouched, setCustomNameTouched] = useState(false);
  const [customArtTouched, setCustomArtTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);

  const draft = useMemo<CryptidProfileDraft>(
    () => ({ handle, cryptidName, sigil, color, presetId: null }),
    [color, cryptidName, handle, sigil]
  );
  const fieldIssues = useMemo(() => validateCryptidProfileFields(draft), [draft]);
  const hasIssues = Object.values(fieldIssues).some((issues) => issues.length > 0);
  const validProfile = useMemo(
    () => (hasIssues ? null : createCryptidProfile(draft)),
    [draft, hasIssues]
  );
  const hasChanges =
    handle !== savedDraft.handle ||
    cryptidName !== savedDraft.cryptidName ||
    sigil !== savedDraft.sigil ||
    color !== savedDraft.color;
  const measurements = sigilMeasurements(sigil);
  const colorOptions = SIGNAL_COLOR_OPTIONS.some(
    (option) => option.value.toLowerCase() === initialColor.toLowerCase()
  )
    ? SIGNAL_COLOR_OPTIONS
    : [{ name: 'Current', value: initialColor }, ...SIGNAL_COLOR_OPTIONS];
  const bareHandle = handle.trim().replace(/^@+/, '');
  // Naming the icon is optional, so the caption under the art is simply absent
  // when it is blank; only the places that need a noun fall back to a word.
  const iconName = cryptidName.trim();
  const iconLabel = iconName || 'Unnamed';
  const colorName =
    colorOptions.find((option) => option.value.toLowerCase() === color.toLowerCase())?.name ??
    'Custom';

  // The hero preview doubles as navigation into the fields it previews: tapping
  // the @handle focuses the username input (always mounted, so a direct focus is
  // enough), tapping the icon opens the icon picker.
  const handleInputRef = useRef<TextInput>(null);
  const focusHandle = useCallback(() => handleInputRef.current?.focus(), []);
  const openIconFromHero = useCallback(() => setActiveEditor('icon'), []);

  const mountedRef = useRef(true);
  const savingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleErrors = handleTouched ? fieldIssues.handle : [];
  const customNameErrors = customNameTouched ? fieldIssues.cryptidName : [];
  const customArtErrors = customArtTouched ? fieldIssues.sigil : [];
  const globalError = saveError ?? notice;

  const saveDraft = async (): Promise<boolean> => {
    if (!validProfile || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(validProfile);
      // Edits made during this request remain drafts; only its snapshot was saved.
      if (mountedRef.current) setSavedDraft(draft);
      return true;
    } catch (error: unknown) {
      if (mountedRef.current) setSaveError(errorMessage(error));
      return false;
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const finish = async (): Promise<void> => {
    if (!onDone) return;
    if ((await saveDraft()) && mountedRef.current) onDone();
  };

  const discardDraft = (): void => {
    if (savingRef.current) return;
    setHandle(savedDraft.handle);
    setCryptidName(savedDraft.cryptidName);
    setSigil(savedDraft.sigil);
    setColor(savedDraft.color);
    setHandleTouched(false);
    setCustomNameTouched(false);
    setCustomArtTouched(false);
    setSaveError(null);
  };

  const applyPersona = (persona: PersonaFields | Omit<PersonaFields, 'color'>): void => {
    setSaveError(null);
    setCryptidName(persona.cryptidName);
    setSigil(persona.sigil);
    if ('color' in persona) setColor(persona.color);
    setCustomNameTouched(false);
    setCustomArtTouched(false);
  };

  const rollPersona = (): void => {
    applyPersona(randomPersona({ avoid: { cryptidName } }));
  };

  const useGeneratedCryptid = (generated: GeneratedCryptid): void => {
    applyPersona({ cryptidName: generated.name, sigil: generated.sigil });
    setActiveEditor('icon');
    setGeneratorOpen(false);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'position'}
      style={[styles.root, { backgroundColor: theme.background }]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + Spacing.four,
            paddingBottom: insets.bottom + Spacing.four,
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.shell}>
          {mode === 'edit' && onDone ? (
            <Pressable
              accessibilityLabel="Back to settings"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onDone}
              style={({ pressed }) => [styles.backButton, { opacity: pressed ? 0.55 : 1 }]}
            >
              <SymbolView
                name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                size={15}
                tintColor={theme.textSecondary}
              />
              <ThemedText type="smallBold" themeColor="textSecondary" style={styles.backButtonText}>
                SETTINGS
              </ThemedText>
            </Pressable>
          ) : null}
          <View style={styles.headerRow}>
            <View style={styles.headerCopy}>
              <ThemedText style={styles.title}>
                {mode === 'onboarding' ? 'Set up your profile' : 'Profile'}
              </ThemedText>
              {mode === 'onboarding' ? (
                <ThemedText type="small" themeColor="textSecondary" style={styles.intro}>
                  Choose how you appear to friends. You can change this later.
                </ThemedText>
              ) : null}
            </View>
          </View>

          {globalError ? (
            <View
              accessibilityLiveRegion="polite"
              style={[
                styles.notice,
                { backgroundColor: theme.backgroundElement, borderColor: chrome.amber },
              ]}
            >
              <ThemedText type="smallBold">Could not save profile changes</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {globalError}
              </ThemedText>
            </View>
          ) : null}

          <View
            style={[
              styles.overview,
              { backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected },
            ]}
          >
            <View style={styles.preview}>
              <Pressable
                accessibilityHint="Replaces the cryptid, its title, and your signal color"
                accessibilityLabel="Randomize profile"
                accessibilityRole="button"
                testID="randomize-persona"
                disabled={saving}
                onPress={rollPersona}
                style={({ pressed }) => [
                  styles.rollButton,
                  { backgroundColor: color, opacity: saving ? 0.38 : pressed ? 0.72 : 1 },
                ]}
              >
                <SymbolView
                  name={{ ios: 'dice', android: 'casino', web: 'casino' }}
                  size={24}
                  tintColor={signalColorInk(color)}
                />
              </Pressable>
              <Pressable
                accessibilityHint="Opens the profile icon picker"
                accessibilityLabel={`Profile icon: ${iconLabel}. Tap to change it.`}
                accessibilityRole="button"
                onPress={openIconFromHero}
                style={({ pressed }) => [styles.previewTarget, { opacity: pressed ? 0.62 : 1 }]}
              >
                <CryptidAvatar
                  art={sigil || ' + '}
                  name={iconName}
                  color={color}
                  size="large"
                  style={styles.previewAvatar}
                />
                {/* The ASCII cryptid is the thing people assume is fixed — it
                    arrives already rolled, and nothing about a block of art says
                    "editable". So the hero says so in words, at the one place
                    everybody looks. */}
                <ThemedText type="small" themeColor="textSecondary" style={styles.changeHint}>
                  TAP THE CRYPTID TO CHANGE IT
                </ThemedText>
              </Pressable>
              <Pressable
                accessibilityHint="Focuses the username field"
                accessibilityLabel={`Username: ${bareHandle ? `@${bareHandle}` : 'not set'}`}
                accessibilityRole="button"
                onPress={focusHandle}
                style={({ pressed }) => [styles.previewTarget, { opacity: pressed ? 0.62 : 1 }]}
              >
                <ThemedText
                  adjustsFontSizeToFit
                  minimumFontScale={0.74}
                  numberOfLines={1}
                  style={[
                    styles.handlePreview,
                    { color: bareHandle ? color : theme.textSecondary },
                  ]}
                >
                  {bareHandle ? `@${bareHandle}` : 'Not set'}
                </ThemedText>
              </Pressable>

              {mode === 'edit' && hasChanges ? (
                <View
                  accessibilityLiveRegion="polite"
                  style={[
                    styles.profileDecision,
                    { backgroundColor: theme.background, borderColor: chrome.amber },
                  ]}
                >
                  <ThemedText type="smallBold">Unsaved profile changes</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    Save or discard your changes.
                  </ThemedText>
                  <View style={styles.profileDecisionActions}>
                    <Pressable
                      accessibilityLabel="Save profile changes"
                      accessibilityRole="button"
                      accessibilityState={{ disabled: hasIssues || saving }}
                      testID="save-profile"
                      disabled={hasIssues || saving}
                      onPress={() => void saveDraft()}
                      style={({ pressed }) => [
                        styles.profileDecisionButton,
                        {
                          backgroundColor: color,
                          borderColor: color,
                          opacity: hasIssues || saving ? 0.38 : pressed ? 0.72 : 1,
                        },
                      ]}
                    >
                      <ThemedText type="smallBold" style={{ color: signalColorInk(color) }}>
                        {saving ? 'Saving...' : 'Save'}
                      </ThemedText>
                    </Pressable>
                    <Pressable
                      accessibilityLabel="Discard profile changes"
                      accessibilityRole="button"
                      accessibilityState={{ disabled: saving }}
                      testID="discard-profile"
                      disabled={saving}
                      onPress={discardDraft}
                      style={({ pressed }) => [
                        styles.profileDecisionButton,
                        {
                          backgroundColor: theme.backgroundElement,
                          borderColor: theme.backgroundSelected,
                          opacity: saving ? 0.38 : pressed ? 0.72 : 1,
                        },
                      ]}
                    >
                      <ThemedText type="smallBold">Discard</ThemedText>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>

            <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />

            {/* Username is always open — it is the one field everybody sets, so
                hiding it behind a disclosure row only adds a tap. */}
            <View style={[styles.inlineEditor, { backgroundColor: theme.background }]}>
              <ThemedText style={styles.fieldLabel}>Username</ThemedText>
              <View
                style={[
                  styles.handleInputShell,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: handleErrors.length > 0 ? chrome.amber : theme.backgroundSelected,
                  },
                ]}
              >
                <ThemedText style={[styles.handlePrefix, { color }]}>@</ThemedText>
                <TextInput
                  accessibilityLabel="Username"
                  testID="username-input"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!saving}
                  maxLength={20}
                  ref={handleInputRef}
                  onBlur={() => setHandleTouched(true)}
                  onChangeText={(value) => {
                    setSaveError(null);
                    setHandleTouched(true);
                    setHandle(value.replace(/^@+/, '').toLowerCase());
                  }}
                  placeholder="username"
                  placeholderTextColor={theme.textSecondary}
                  selectionColor={color}
                  spellCheck={false}
                  style={[styles.handleInput, { color: theme.text }]}
                  value={handle}
                />
              </View>
              <FieldNote
                errorColor={chrome.amberDark}
                issues={handleErrors}
                hint={USERNAME_GUIDANCE}
              />
            </View>

            <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />

            <SettingRow
              active={activeEditor === 'icon'}
              label="Profile icon"
              value={iconLabel}
              onPress={() => setActiveEditor((current) => (current === 'icon' ? null : 'icon'))}
            />

            {activeEditor === 'icon' ? (
              <View style={[styles.inlineEditor, { backgroundColor: theme.background }]}>
                {Platform.OS !== 'ios' ? (
                  <Pressable
                    accessibilityHint="Draws an icon from a description, on this phone"
                    accessibilityLabel="Generate a profile icon"
                    accessibilityRole="button"
                    disabled={saving}
                    onPress={() => setGeneratorOpen(true)}
                    style={({ pressed }) => [
                      styles.iconActionButton,
                      {
                        backgroundColor: theme.backgroundElement,
                        borderColor: theme.backgroundSelected,
                        opacity: saving ? 0.38 : pressed ? 0.62 : 1,
                      },
                    ]}
                  >
                    <ThemedText style={[styles.iconActionGlyph, { color }]}>{'{*}'}</ThemedText>
                    <ThemedText type="small" style={styles.iconActionLabel}>
                      Generate
                    </ThemedText>
                  </Pressable>
                ) : null}

                {/* Custom is not a mode any more — the fields below ARE the custom
                    option, and they stay open so a rolled or generated icon can be
                    edited straight away. */}
                <View style={styles.customFields}>
                  <ThemedText style={styles.fieldLabel}>Icon name</ThemedText>
                  <TextInput
                    accessibilityLabel="Custom profile icon name"
                    autoCapitalize="words"
                    editable={!saving}
                    maxLength={24}
                    onBlur={() => setCustomNameTouched(true)}
                    onChangeText={(value) => {
                      setSaveError(null);
                      setCustomNameTouched(true);
                      setCryptidName(value);
                    }}
                    placeholder="Icon name"
                    placeholderTextColor={theme.textSecondary}
                    selectionColor={color}
                    style={[
                      styles.textInput,
                      {
                        backgroundColor: theme.backgroundElement,
                        borderColor:
                          customNameErrors.length > 0 ? chrome.amber : theme.backgroundSelected,
                        color: theme.text,
                      },
                    ]}
                    value={cryptidName}
                  />
                  <FieldNote
                    errorColor={chrome.amberDark}
                    issues={customNameErrors}
                    hint="Optional. Up to 24 characters."
                  />

                  <View style={styles.asciiLabelRow}>
                    <ThemedText style={styles.fieldLabel}>ASCII art</ThemedText>
                    <ThemedText type="code" themeColor="textSecondary">
                      {measurements.lines}/{MAX_SIGIL_LINES} lines · {measurements.columns}/
                      {MAX_SIGIL_COLUMNS} columns
                    </ThemedText>
                  </View>
                  <TextInput
                    accessibilityLabel="Custom ASCII profile icon"
                    allowFontScaling={false}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!saving}
                    multiline
                    onBlur={() => setCustomArtTouched(true)}
                    onChangeText={(value) => {
                      setSaveError(null);
                      setCustomArtTouched(true);
                      setSigil(normalizeAsciiArt(value));
                    }}
                    placeholder={'Enter ASCII art.\nSpaces and line breaks are preserved.'}
                    placeholderTextColor={theme.textSecondary}
                    selectionColor={color}
                    spellCheck={false}
                    style={[
                      styles.asciiInput,
                      {
                        backgroundColor: theme.backgroundElement,
                        borderColor:
                          customArtErrors.length > 0 ? chrome.amber : theme.backgroundSelected,
                        color,
                      },
                    ]}
                    textAlignVertical="top"
                    value={sigil}
                  />
                  <FieldNote
                    errorColor={chrome.amberDark}
                    issues={customArtErrors}
                    hint="ASCII characters only. Spacing and line breaks are preserved."
                  />
                </View>
              </View>
            ) : null}

            <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />

            <SettingRow
              active={activeEditor === 'signal'}
              label="Signal color"
              value={colorName}
              onPress={() => setActiveEditor((current) => (current === 'signal' ? null : 'signal'))}
            />

            {activeEditor === 'signal' ? (
              <View style={[styles.inlineEditor, { backgroundColor: theme.background }]}>
                <ThemedText style={styles.fieldLabel}>Choose a signal color</ThemedText>
                <Suspense fallback={null}>
                  <SignalColorPicker
                    color={color}
                    disabled={saving}
                    onChange={(value) => {
                      setSaveError(null);
                      setColor(value);
                    }}
                  />
                </Suspense>
                <ThemedText style={styles.fieldLabel}>Quick colors</ThemedText>
                <View
                  accessibilityLabel="Signal color"
                  accessibilityRole="radiogroup"
                  style={styles.colorOptions}
                >
                  {colorOptions.map((option) => {
                    const selected = option.value.toLowerCase() === color.toLowerCase();
                    return (
                      <Pressable
                        accessibilityLabel={`${option.name} signal color`}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        key={option.value}
                        disabled={saving}
                        onPress={() => {
                          setSaveError(null);
                          setColor(option.value);
                        }}
                        style={({ pressed }) => [
                          styles.colorOption,
                          {
                            backgroundColor: selected
                              ? `${option.value}14`
                              : theme.backgroundElement,
                            borderColor: selected ? option.value : theme.backgroundSelected,
                            opacity: saving ? 0.38 : pressed ? 0.58 : 1,
                          },
                        ]}
                      >
                        <View style={[styles.colorSwatch, { backgroundColor: option.value }]}>
                          {selected ? (
                            <View
                              style={[
                                styles.colorSelected,
                                { backgroundColor: signalColorInk(option.value) },
                              ]}
                            />
                          ) : null}
                        </View>
                        <ThemedText type="small" style={styles.colorName}>
                          {option.name}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>

          {mode === 'onboarding' && onDone ? (
            <Pressable
              accessibilityRole="button"
              testID="onboarding-continue"
              accessibilityState={{ disabled: hasIssues || saving }}
              disabled={hasIssues || saving}
              onPress={() => void finish()}
              style={({ pressed }) => [
                styles.continueButton,
                {
                  backgroundColor: color,
                  opacity: hasIssues || saving ? 0.38 : pressed ? 0.72 : 1,
                },
              ]}
            >
              <ThemedText style={[styles.continueButtonText, { color: signalColorInk(color) }]}>
                {saving ? 'Saving...' : 'Continue'}
              </ThemedText>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
      {Platform.OS !== 'ios' ? (
        <CryptidGeneratorDialog
          color={color}
          onClose={() => setGeneratorOpen(false)}
          onUse={useGeneratedCryptid}
          visible={generatorOpen}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function SettingRow({
  active,
  label,
  value,
  onPress,
}: {
  active: boolean;
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.settingRow, { opacity: pressed ? 0.58 : 1 }]}
    >
      <View style={styles.settingCopy}>
        <ThemedText style={styles.settingLabel}>{label}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {value}
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.editLabel}>
        {active ? 'Close' : 'Edit'}
      </ThemedText>
    </Pressable>
  );
}

function FieldNote({
  issues,
  hint,
  errorColor,
}: {
  issues: readonly string[];
  hint: string;
  errorColor: string;
}) {
  const hasError = issues.length > 0;
  return (
    <ThemedText
      accessibilityLiveRegion={hasError ? 'polite' : 'none'}
      type="small"
      themeColor={hasError ? undefined : 'textSecondary'}
      style={hasError ? { color: errorColor } : undefined}
    >
      {hasError ? issues.join(' ') : hint}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.four,
  },
  shell: {
    alignSelf: 'center',
    gap: Spacing.three,
    maxWidth: PROFILE_MAX_WIDTH,
    width: '100%',
  },
  headerRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
  },
  headerCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  title: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.4,
    lineHeight: 40,
  },
  intro: {
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 480,
  },
  backButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.one,
    minHeight: 32,
  },
  backButtonText: {
    letterSpacing: 1,
  },
  notice: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  overview: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  preview: {
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 224,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.five,
  },
  previewTarget: {
    // Stretch (not shrink-wrap) so the handle's `maxWidth: '100%'` still resolves
    // against the preview's content width and `adjustsFontSizeToFit` keeps working.
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  previewAvatar: {
    minHeight: 126,
  },
  changeHint: {
    fontFamily: Fonts.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    marginTop: Spacing.one,
    textAlign: 'center',
  },
  handlePreview: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 32,
    fontWeight: '700',
    includeFontPadding: true,
    letterSpacing: 0.2,
    lineHeight: 42,
    maxWidth: '100%',
    paddingBottom: 2,
    textAlign: 'center',
  },
  rollButton: {
    alignItems: 'center',
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: Spacing.three,
    top: Spacing.three,
    width: 44,
    zIndex: 1,
  },
  profileDecision: {
    alignSelf: 'stretch',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  profileDecisionActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    paddingTop: Spacing.one,
  },
  profileDecisionButton: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    flexBasis: 120,
    flexGrow: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: Spacing.three,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  settingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 72,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  settingCopy: {
    flex: 1,
    gap: 3,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
  editLabel: {
    fontWeight: '700',
  },
  inlineEditor: {
    gap: Spacing.two,
    padding: Spacing.three,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  handleInputShell: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 54,
    paddingHorizontal: Spacing.three,
  },
  handlePrefix: {
    fontFamily: Fonts.mono,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
  },
  handleInput: {
    flex: 1,
    fontFamily: Fonts.mono,
    fontSize: 17,
    lineHeight: 24,
    paddingHorizontal: Spacing.one,
    paddingVertical: Spacing.two,
  },
  iconActionButton: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    gap: Spacing.one,
    justifyContent: 'center',
    minHeight: 88,
    minWidth: 120,
    padding: Spacing.two,
  },
  iconActionGlyph: {
    fontFamily: Fonts.mono,
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 34,
  },
  iconActionLabel: {
    fontWeight: '700',
  },
  customFields: {
    gap: Spacing.two,
    paddingTop: Spacing.two,
  },
  colorOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  colorOption: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    flexBasis: '28%',
    flexGrow: 1,
    gap: Spacing.one,
    minHeight: 74,
    minWidth: 84,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  colorSwatch: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  colorSelected: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  colorName: {
    fontWeight: '700',
  },
  textInput: {
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 52,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  asciiLabelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    justifyContent: 'space-between',
    marginTop: Spacing.two,
  },
  asciiInput: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: Fonts.mono,
    fontSize: 14,
    lineHeight: 19,
    minHeight: 180,
    padding: Spacing.three,
  },
  continueButton: {
    alignItems: 'center',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: Spacing.three,
  },
  continueButtonText: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
});
