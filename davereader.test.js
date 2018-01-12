const davereader = require('./davereader');

test('Has davereader', () => {
    myProductName = davereader.__get__('myProductName');
    expect(myProductName).toBe('River5');
});
