/** The hook a native Coordinator turn waits on; the device route resumes it after each submit. Pure: workflow code imports it. */
export const nativeTurnToken = (turnId: string) => 'native-turn:' + turnId
