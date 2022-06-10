/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

export const ISessionSyncWorkbenchService = createDecorator<ISessionSyncWorkbenchService>('ISessionSyncWorkbenchService');
export interface ISessionSyncWorkbenchService {
	_serviceBrand: undefined;

	read(): Promise<EditSession | undefined>;
	write(editSession: EditSession): Promise<void>;
}

export enum ChangeType {
	Addition = 1,
	Deletion = 2,
}

export enum FileType {
	File = 1,
}

interface Addition {
	relativeFilePath: string;
	fileType: FileType.File;
	contents: string;
	type: ChangeType.Addition;
}

interface Deletion {
	relativeFilePath: string;
	fileType: FileType.File;
	contents: undefined;
	type: ChangeType.Deletion;
}

export type Change = Addition | Deletion;

export interface Folder {
	name: string;
	workingChanges: Change[];
}

export interface EditSession {
	version: 1;
	folders: Folder[];
}
