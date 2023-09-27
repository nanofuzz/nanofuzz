export declare type FuzzIoElement = {
    name: string;
    offset: number;
    value: any;
};
export declare type FuzzTestResult = {
    pinned: boolean;
    input: FuzzIoElement[];
    output: FuzzIoElement[];
    exception: boolean;
    exceptionMessage?: string;
    stack?: string;
    timeout: boolean;
    passedImplicit: boolean;
    passedExplicit?: boolean;
    elapsedTime: number;
    correct: string;
    expectedOutput?: any;
};
