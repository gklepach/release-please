// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  ChangelogSection,
  ChangelogNotes,
  BuildNotesOptions,
} from '../changelog-notes';
import {ConventionalCommit} from '../commit';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const conventionalChangelogWriter = require('conventional-changelog-writer');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const presetFactory = require('conventional-changelog-conventionalcommits');
const DEFAULT_HOST = 'https://github.com';

interface DefaultChangelogNotesOptions {
  commitPartial?: string;
  headerPartial?: string;
  mainTemplate?: string;
}

interface Note {
  title: string;
  text: string;
}

export class DefaultChangelogNotes implements ChangelogNotes {
  // allow for customized commit template.
  private commitPartial?: string;
  private headerPartial?: string;
  private mainTemplate?: string;

  constructor(options: DefaultChangelogNotesOptions = {}) {
    this.commitPartial = options.commitPartial;
    this.headerPartial = options.headerPartial;
    this.mainTemplate = options.mainTemplate;
  }

  async buildNotes(
    commits: ConventionalCommit[],
    options: BuildNotesOptions
  ): Promise<string> {
    const context = {
      host: options.host || DEFAULT_HOST,
      owner: options.owner,
      repository: options.repository,
      version: options.version,
      previousTag: options.previousTag,
      currentTag: options.currentTag,
      linkCompare: !!options.previousTag,
    };

    const config: {[key: string]: ChangelogSection[]} = {};
    // Default sections closely aligned with internal filtering, keep most hidden (e.g., docs)
    // and add a visible Others section for non-conventional/JIRA-like commits.
    const defaultTypes: ChangelogSection[] = [
      {type: 'feat', section: 'Features'},
      {type: 'fix', section: 'Bug Fixes'},
      {type: 'perf', section: 'Performance Improvements'},
      {type: 'revert', section: 'Reverts'},
      {type: 'chore', section: 'Miscellaneous Chores', hidden: true},
      {type: 'docs', section: 'Documentation', hidden: true},
      {type: 'style', section: 'Styles', hidden: true},
      {type: 'refactor', section: 'Code Refactoring', hidden: true},
      {type: 'test', section: 'Tests', hidden: true},
      {type: 'build', section: 'Build System', hidden: true},
      {type: 'ci', section: 'Continuous Integration', hidden: true},
    ];
    const types: ChangelogSection[] = options.changelogSections
      ? [...options.changelogSections]
      : defaultTypes;
    if (!types.find(t => t.type === 'others')) {
      types.push({type: 'others', section: 'Others'});
    }
    config.types = types;
    const preset = await presetFactory(config);
    preset.writerOpts.commitPartial =
      this.commitPartial || preset.writerOpts.commitPartial;
    preset.writerOpts.headerPartial =
      this.headerPartial || preset.writerOpts.headerPartial;
    preset.writerOpts.mainTemplate =
      this.mainTemplate || preset.writerOpts.mainTemplate;
    const sectionTypes: string[] = (config.types || []).map(t => t.type);
    const jiraLike = /^[A-Z][A-Z0-9]+-\d+$/;

    // Optionally augment with non-conventional raw commits (no type, no JIRA-like prefix)
    let augmentedCommits: ConventionalCommit[] = commits;
    if (options.commits && options.commits.length > 0) {
      const includedShas = new Set(commits.map(c => c.sha));
      const isConventionalHeader = /^[a-z]+(\(.*\))?!?:\s/;
      const isJiraHeader = /^[A-Z][A-Z0-9]+-\d+:\s/;
      const hasLetters = /[A-Za-z]/;
      const extras: ConventionalCommit[] = [];
      for (const raw of options.commits) {
        if (includedShas.has(raw.sha)) continue;
        const firstLine = (raw.message.split(/\r?\n/)[0] || '').trim();
        if (!firstLine) continue;
        if (!hasLetters.test(firstLine)) continue; // avoid adding pure numeric like versions
        if (isConventionalHeader.test(firstLine)) continue;
        if (isJiraHeader.test(firstLine)) continue; // parsed separately
        extras.push({
          sha: raw.sha,
          message: firstLine,
          files: raw.files,
          pullRequest: raw.pullRequest,
          type: 'others',
          scope: null,
          bareMessage: firstLine,
          notes: [],
          references: [],
          breaking: false,
        });
      }
      if (extras.length > 0) {
        augmentedCommits = commits.concat(extras);
      }
    }

    const changelogCommits = augmentedCommits.map(commit => {
      // Map unknown types like JIRA keys (ABC-123) into 'others'
      const normalizedType =
        sectionTypes.includes(commit.type) || !jiraLike.test(commit.type)
          ? commit.type
          : 'others';
      const notes = commit.notes
        .filter(note => note.title === 'BREAKING CHANGE')
        .map(note =>
          replaceIssueLink(
            note,
            context.host,
            context.owner,
            context.repository
          )
        );
      return {
        body: '', // commit.body,
        subject: htmlEscape(commit.bareMessage),
        type: normalizedType,
        scope: commit.scope,
        notes,
        references: commit.references,
        mentions: [],
        merge: null,
        revert: null,
        header: commit.message,
        footer: commit.notes
          .filter(note => note.title === 'RELEASE AS')
          .map(note => `Release-As: ${note.text}`)
          .join('\n'),
        hash: commit.sha,
      };
    });

    return conventionalChangelogWriter
      .parseArray(changelogCommits, context, preset.writerOpts)
      .trim();
  }
}

function replaceIssueLink(
  note: Note,
  host: string,
  owner: string,
  repo: string
): Note {
  note.text = note.text.replace(
    /\(#(\d+)\)/,
    `([#$1](${host}/${owner}/${repo}/issues/$1))`
  );
  return note;
}

function htmlEscape(message: string): string {
  return message.replace(/``[^`].*[^`]``|`[^`]*`|<|>/g, match =>
    match.length > 1 ? match : match === '<' ? '&lt;' : '&gt;'
  );
}
