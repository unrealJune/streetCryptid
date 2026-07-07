# streetCryptid — common developer tasks.
# Run `just` (or `just --list`) to see every recipe.
# Package manager: bun. Recipes are POSIX-sh friendly (works on Windows via Git sh, macOS, and Linux).

# Show the list of available recipes.
default:
    @just --list

# --- Setup -------------------------------------------------------------------

# Install dependencies from the lockfile.
install:
    bun install

# Nuke node_modules and reinstall from scratch.
reset:
    rm -rf node_modules && bun install

# --- Dev servers -------------------------------------------------------------

# Start the Metro dev server (then press a=Android, i=iOS, w=web).
start:
    bun run start

# Start the dev server with the Metro cache cleared.
start-clear:
    bunx expo start --clear

# Open the app on a connected Android device / emulator.
android:
    bun run android

# Open the app on an iOS simulator (macOS only).
ios:
    bun run ios

# Open the app in a web browser.
web:
    bun run web

# --- Native / prebuild -------------------------------------------------------

# Compile & install a native Android debug build (needs Android SDK + JDK).
run-android:
    bunx expo run:android

# Compile & install a native iOS debug build (macOS only).
run-ios:
    bunx expo run:ios

# Generate the native android/ and ios/ projects (managed prebuild).
prebuild:
    bun run prebuild

# Clean-regenerate the native projects.
prebuild-clean:
    bunx expo prebuild --clean

# --- Quality -----------------------------------------------------------------

# Type-check with tsc. Run `just start` once first so Expo generates its types.
typecheck:
    bun run typecheck

# Lint with ESLint (eslint-config-expo).
lint:
    bun run lint

# Lint and auto-fix what can be fixed.
lint-fix:
    bun run lint:fix

# Format every file with Prettier.
format:
    bun run format

# Verify formatting without writing changes.
format-check:
    bun run format:check

# Run the full local gate: types, lint, and formatting.
check: typecheck lint format-check

# Expo project health check.
doctor:
    bunx expo-doctor

# Verify installed deps match the current Expo SDK.
deps-check:
    bunx expo install --check

# Upgrade deps to match the current Expo SDK.
deps-fix:
    bunx expo install --fix

# --- EAS: cloud build / submit / update --------------------------------------

# Log in to your Expo (EAS) account.
eas-login:
    bunx eas-cli login

# Link this project to an EAS project (writes the projectId).
eas-init:
    bunx eas-cli init

# Build via EAS. Examples: `just build`, `just build ios`, `just build android production`.
build platform="android" profile="preview":
    bunx eas-cli build --platform {{platform}} --profile {{profile}}

# Build an installable development client.
build-dev platform="android":
    bunx eas-cli build --platform {{platform}} --profile development

# Production build.
build-prod platform="android":
    bunx eas-cli build --platform {{platform}} --profile production

# Submit the latest build to the store. Example: `just submit ios`.
submit platform="android":
    bunx eas-cli submit --platform {{platform}}

# Publish an over-the-air update. Example: `just update "fix crash"`.
update message="update":
    bunx eas-cli update --auto --message "{{message}}"

# --- Housekeeping ------------------------------------------------------------

# Remove caches and build outputs (keeps node_modules).
clean:
    rm -rf .expo dist web-build node_modules/.cache

# Print key tool versions.
versions:
    @bun --version && bunx expo --version
