import * as React from 'react';
import * as ReactNativeScript from 'react-nativescript';
import { AppShell } from './shell/AppShell';

// In NativeScript, the app.ts file is the entry point to your application.

// Controls react-nativescript log verbosity.
// - true: all logs;
// - false: only error logs.
Object.defineProperty(globalThis, '__DEV__', { value: false });

ReactNativeScript.start(React.createElement(AppShell, {}, null));

// Do not place any code after the application has been started as it will not
// be executed on iOS.
