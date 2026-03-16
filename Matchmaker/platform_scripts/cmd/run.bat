@Rem Copyright Epic Games, Inc. All Rights Reserved.

@echo off

@Rem Set script directory as working directory.
pushd "%~dp0"

title Matchmaker

@Rem Run setup to ensure we have node and matchmaker installed.
call setup.bat

@Rem Move to matchmaker.js directory.
pushd ..\..

@Rem Prefer system Node if available (requires >=18.18.0), fall back to bundled.
where node >nul 2>&1
if %errorlevel% equ 0 (
    echo Using system Node:
    node --version
    node matchmaker %*
) else (
    echo Using bundled Node:
    platform_scripts\cmd\node\node.exe --version
    platform_scripts\cmd\node\node.exe matchmaker %*
)

@Rem Pop matchmaker.js directory.
popd

@Rem Pop script directory.
popd

pause