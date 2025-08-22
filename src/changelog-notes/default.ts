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
    if (options.changelogSections) {
      config.types = options.changelogSections;
    }
    // preset will be created after we ensure sections and possibly add Others
    const jiraHeader = /^(\[[A-Z][A-Z0-9]+-\d+\]|[A-Z][A-Z0-9]+-\d+):\s/;
    const trackerPrefixes = options.trackerList && options.trackerList.length > 0 ? options.trackerList : undefined;
    const trackerUrl = options.trackerUrl;
    const issueKeyRegex = trackerPrefixes
      ? new RegExp(`(?:^|[^A-Z0-9])((?:${trackerPrefixes.map(p => p.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})-\\d+)`, 'g')
      : /(?:^|[^A-Z0-9])(([A-Z][A-Z0-9]+-\d+))/g;
    const seenShas = new Set<string>();
    const changelogCommits = commits.map(commit => {
      if (commit.sha) seenShas.add(commit.sha);
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
      const headerLine = commit.message;
      const isJiraHeader = jiraHeader.test(headerLine);
      let subject = isJiraHeader
        ? htmlEscape(headerLine)
        : htmlEscape(commit.bareMessage);
      if (trackerUrl) {
        subject = subject.replace(issueKeyRegex, (m: string, key: string) => {
          const prefix = m.slice(0, m.indexOf(key));
          const link = `[${key}](${trackerUrl}${key})`;
          return `${prefix}${link}`;
        });
      }
      const type = isJiraHeader ? 'others' : commit.type;
      return {
        body: '', // commit.body,
        subject,
        type,
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

    // Add raw commits that look like issue-key headers but were not parsed as conventional commits
    if (options.commits) {
      const rawIssueHeader = /^(\[[A-Z][A-Z0-9]+-\d+\]|[A-Z][A-Z0-9]+-\d+)\b/;
      const conventionalHeader = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.*?\))?:\s/;
      const mergeHeader = /^Merge\b/;
      const skipRelease = /release[- ]please|^chore\(main\): release/i;
      for (const raw of options.commits) {
        if (seenShas.has(raw.sha)) continue;
        const msg = raw.message.split('\n')[0];
        // Include if it has an issue-like header OR it's a non-conventional, non-merge miscellaneous commit
        if (!rawIssueHeader.test(msg)) {
          if (conventionalHeader.test(msg)) continue;
          if (mergeHeader.test(msg)) continue;
          if (skipRelease.test(msg)) continue;
        }
        let subject = htmlEscape(msg);
        if (trackerUrl) {
          subject = subject.replace(issueKeyRegex, (m: string, key: string) => {
            const prefix = m.slice(0, m.indexOf(key));
            const link = `[${key}](${trackerUrl}${key})`;
            return `${prefix}${link}`;
          });
        }
        changelogCommits.push({
          body: '',
          subject,
          type: 'others',
          scope: null,
          notes: [],
          references: [],
          mentions: [],
          merge: null,
          revert: null,
          header: msg,
          footer: '',
          hash: raw.sha,
        });
      }
    }

    const preset = await presetFactory(config);
    preset.writerOpts.commitPartial =
      this.commitPartial || preset.writerOpts.commitPartial;
    preset.writerOpts.headerPartial =
      this.headerPartial || preset.writerOpts.headerPartial;
    preset.writerOpts.mainTemplate =
      this.mainTemplate || preset.writerOpts.mainTemplate;

    let rendered = conventionalChangelogWriter
      .parseArray(changelogCommits, context, preset.writerOpts)
      .trim();

    // Writer sometimes renders только заголовок выпуска без секций.
    const hasSectionsOrBullets = /\n###\s|\n\*\s/.test(rendered);
    // If writer produced sections/bullets, we still may want to append Others below

    // Fallback: если writer вернул пусто (или только заголовок), а Others есть — дорисуем вручную
    const others = changelogCommits.filter(c => c.type === 'others');
    if (others.length > 0) {
      const lines: string[] = [];
      if (rendered.length > 0) {
        lines.push(rendered);
      }
      // Add Others section at the end
      if (lines.length > 0) lines.push('');
      lines.push('### Others');
      lines.push('');
      for (const c of others) {
        const shortSha = (c as any).hash || '';
        const sha7 = shortSha ? String(shortSha).slice(0, 7) : '';
        const link = sha7
          ? `([${sha7}](${context.host}/${context.owner}/${context.repository}/commit/${shortSha}))`
          : '';
        lines.push(`* ${c.subject} ${link}`.trim());
      }
      rendered = lines.join('\n');
    }
    return rendered;
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
