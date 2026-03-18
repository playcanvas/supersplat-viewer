#!/bin/bash -e

TYPE=$1
PRE_RELEASE=${2:-false}

if [[ ! " major minor patch " =~ " $TYPE " ]]; then
    echo "Usage: $0 (major|minor|patch)"
    exit 1
fi

# Fetch all remote tags
git fetch --tags

# Calculate the next version
if [[ "$PRE_RELEASE" != "false" ]]; then
     npm version pre$TYPE --preid=$PRE_RELEASE --no-git-tag-version >> /dev/null
else
     npm version $TYPE --no-git-tag-version >> /dev/null
fi
NEXT_VERSION=$(npm pkg get version | sed 's/"//g')
git reset --hard >> /dev/null

# Confirm release
read -p "About to release 'v$NEXT_VERSION'. Continue? (y/N) " -r
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Release cancelled."
    exit 1
fi

# Tag release
if [[ "$PRE_RELEASE" != "false" ]]; then
    npm version pre$TYPE --preid=$PRE_RELEASE
else
    npm version $TYPE
fi