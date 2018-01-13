const davereader = require('./davereader');

test('Has davereader', () => {
	const myProductName = davereader.__get__('myProductName');
	expect(myProductName).toBe('River5');
});
