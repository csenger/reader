const davereader = require('./davereader');
const packageData = require('./package.json');

test('Has myProductName', () => {
	const myProductName = davereader.__get__('myProductName');
	expect(myProductName).toBe(packageData.name);
});

test('Has myVersion', () => {
	const myVersion = davereader.__get__('myVersion');
	expect(myVersion).toBe(packageData.version);
});
