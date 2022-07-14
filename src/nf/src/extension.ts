import * as vscode from 'vscode';
/**
 * MAKE SURE TO REPLACE DUMMY FUZZER FILENAME & NAME IN LINE 18,27,28;
 * @param context 
 */

//TODO: Add function for parsing arguments
//TODO: Change BuildSequence to pass in arguments to fuzzer. 


interface Minmax { //Class for storing argument name, min & max values
	argument: string,
	min: number,
	max: number;
}

export function activate(context: vscode.ExtensionContext) {
	var terminal = vscode.window.createTerminal('jest');
	//The fuzz function
	context.subscriptions.push(vscode.commands.registerCommand('nanofuzz.Fuzz', async ()=> { //Adding the Fuzz command through the extension. 
		const editor = vscode.window.activeTextEditor; //The page you are writing code on
		if(!editor){ //Catch for nulls
			return;
		}
		let funcpos = editor.document.getWordRangeAtPosition(editor.selection.active);  //Get the the line number and character number for clicked cursor position
		let funcName = editor.document.getText(funcpos); //gather text at the position above. Collects every character until spaces encountered on either side.
		const functionPath = editor.document.uri.path; //full path of the file which the function is in.
		const fuzzerPath = ""; //Placeholder fuzzer path. REPLACE
		let ranges: Minmax[] = [];
		let args = argSynthesizer(()=>{}); //Dummy function for getting all arguments out.
		for(let i = 0; i< args.length; i++){
			var min = await vscode.window.showInputBox({ //How to enforce floats only?
				prompt: "Please enter a minimum value, floats only"
			});
			if(min){
				var max = await vscode.window.showInputBox({
				prompt: "Please enter a maximum value, floats only",
				});
				if(max){
					const minmax = {
					argument: args[i],
					min: parseFloat(min),
					max: parseFloat(max)
					};
					ranges[i] = minmax;
					console.log(ranges[i]);
				}
			}
		}
		terminal.sendText(`ts-node -e \'`+ buildSequence(functionPath, funcName, fuzzerPath) +`\'`); //Prints out values to terminal automatically, using the buildSequence helper function
	}));
	context.subscriptions.push(vscode.commands.registerCommand('nanofuzz.AskPrompt', () => {
	}));
}

export function deactivate() {}


/**
 * For some reason, const x = require(...); doesn't work here. I have to write import statements instead.
 * This function imports the fuzzer and the function needed to be fuzzed. 
 * @param functionPath 
 * @param functionName 
 * @param fuzzerPath 
 * @returns 
 */
var buildSequence = (functionPath: string, functionName:string, fuzzerPath: string):string => { 
    const importFunction = `import{ ` +functionName + ` } from "`+ functionPath.substring(0, functionPath.length-3) + `";`;  // Get the function file imported into terminal.
    const importFuzzer = `import { Fuzzer } from "` +  fuzzerPath + '";'; //Placeholder fuzzer name
	const actString = "Fuzzer(" + functionName + ");"; //Fuzzer needs to ALWAYS be named "Fuzzer" but this can be changed easily.
    return (importFunction + " "+ importFuzzer + " "+ actString);
};

var argSynthesizer = (func: Function) => { //Dummy function for returning the arguments;
	return ["hello1", "hello2", "hello3"];
};